import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import { barRows, gaugeRow, INK, timeLeft } from './draw'
import type { BarRow, Gauge } from './draw'
import type { CiInfo, EvalInfo, RepoInfo, SessionInfo, UsedInfo } from '../types'

const repo = atom({ plugin: 'pitbox', key: 'bandRepo' } as const, null)
const ci = atom({ plugin: 'pitbox', key: 'bandCi' } as const, null)
const evals = atom({ plugin: 'pitbox', key: 'bandEvals' } as const, null)
const session = atom({ plugin: 'pitbox', key: 'bandSession' } as const, null)
const NONE: UsedInfo = { skills: [], spokes: [], agents: [] }
const used = atom({ plugin: 'pitbox', key: 'bandUsed' } as const, NONE)

// What the commit and pull-request buttons send, as if the person typed it.
const COMMIT_PROMPT = 'Commit the current changes.'
const PR_PROMPT = 'Open a pull request for this branch.'

const EVAL_DIR = 'evals/results'
const REFRESH_MS = 30_000
// `gh` goes over the network, so CI is asked at most this often.
const CI_EVERY_MS = 120_000
let ciCheckedAt = 0
let ciBranch = ''
// A hub opening one of its bundled specialists: .../bundled/<spoke>/SKILL.md
const SPOKE = /[\\/]bundled[\\/]([^\\/]+)[\\/]SKILL\.md$/i

// `git status --porcelain=v2 --branch`: "# branch.head", "# branch.ab +A -B",
// then one line per entry: "1"/"2"/"u" changed, "?" untracked.
function parseStatus(text: string): RepoInfo {
  const info: RepoInfo = { branch: '?', ahead: 0, behind: 0, changed: 0, untracked: 0 }

  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      info.branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.slice('# branch.ab '.length).trim().split(' ')
      info.ahead = Math.abs(Number(a) || 0)
      info.behind = Math.abs(Number(b) || 0)
    } else if (line.startsWith('? ')) {
      info.untracked += 1
    } else if (/^[12u] /.test(line)) {
      info.changed += 1
    }
  }

  return info
}

function shortModel(model: string): string {
  // "claude-opus-5-5" -> "Opus 5.5"; anything else is shown as given.
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(model)

  return match === null
    ? model
    : `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`
}

// One colored run of the band. Colors are theme keys, so they follow the person's theme.
type Part = { text: string; color?: Color; dim?: boolean; bold?: boolean }

const SEP: Part = { text: '  ·  ', dim: true }

function level(pct: number, good: number, ok: number): Color {
  return pct >= good ? 'success' : pct >= ok ? 'warning' : 'error'
}

function joinGroups(groups: Part[][]): Part[] {
  return groups.flatMap((group, i) => (i === 0 ? group : [SEP, ...group]))
}

function addOnce(list: string[], name: string): string[] {
  return list.includes(name) ? list : [...list, name]
}

async function refreshSession($: EngineInterface): Promise<void> {
  try {
    const model = await $.session.model()
    const usage = await $.session.usage()
    const info: SessionInfo = {
      model,
      usd: usage.cost?.usd ?? null,
      contextPercent: usage.context.percent ?? null,
      limits: usage.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
    }
    await update($, session, () => info)
  } catch {
    await update($, session, () => null)
  }
}

async function refreshCi($: EngineInterface, cwd: string, branch: string): Promise<void> {
  if (branch === '' || branch === '(detached)') {
    await update($, ci, () => null)
    return
  }

  const now = await $.clock.now()

  if (branch === ciBranch && now - ciCheckedAt < CI_EVERY_MS) {
    return
  }

  ciBranch = branch
  ciCheckedAt = now

  try {
    const ran = await $.process.run(
      ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'workflowName,status,conclusion'],
      { cwd },
    )
    const runs = ran.exitCode === 0 ? (JSON.parse(ran.stdout) as { workflowName: string; status: string; conclusion: string }[]) : []
    const latest: CiInfo | null =
      runs.length > 0 ? { workflow: runs[0].workflowName, status: runs[0].status, conclusion: runs[0].conclusion } : null
    await update($, ci, () => latest)
  } catch {
    await update($, ci, () => null)
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()

  let branch = ''

  try {
    const ran = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { cwd })
    const info = ran.exitCode === 0 ? parseStatus(ran.stdout) : null
    branch = info?.branch ?? ''
    await update($, repo, () => info)
  } catch {
    await update($, repo, () => null)
  }

  await refreshCi($, cwd, branch)

  try {
    const entries = await $.fs.list(`${cwd}/${EVAL_DIR}`)
    const newest = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

    if (newest === undefined) {
      await update($, evals, () => null)
    } else {
      const report = JSON.parse(await $.fs.read(`${cwd}/${EVAL_DIR}/${newest.name}`)) as {
        cases?: { arms?: { with?: { passed?: boolean }[] } }[]
      }
      let passed = 0
      let total = 0

      for (const testCase of report.cases ?? []) {
        for (const run of testCase.arms?.with ?? []) {
          total += 1
          passed += run.passed === true ? 1 : 0
        }
      }

      const found: EvalInfo | null = total > 0 ? { passed, total, file: newest.name } : null
      await update($, evals, () => found)
    }
  } catch {
    await update($, evals, () => null)
  }

  await refreshSession($)
}

// The Refresh button asks CI again too, past the throttle.
async function refreshNow($: EngineInterface): Promise<void> {
  ciCheckedAt = 0
  await refresh($)
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

function ciPart(build: CiInfo): Part {
  if (build.status !== 'completed') {
    return { text: `${build.status.replace(/_/g, ' ')}…`, color: 'warning' }
  }

  const color: Color =
    build.conclusion === 'success' ? 'success' : build.conclusion === 'skipped' || build.conclusion === 'cancelled' ? 'subtle' : 'error'

  return { text: build.conclusion === 'success' ? `✓ ${build.workflow}` : `✗ ${build.workflow} ${build.conclusion}`, color }
}

// register.tsx hooks each of these events once for the whole plugin and calls both halves.
let stopTimer: (() => void) | undefined

export async function bandStart($: EngineInterface): Promise<void> {
  await refresh($)
  stopTimer?.()
  stopTimer = $.clock.every(REFRESH_MS, () => void refresh($))
}

// A new prompt starts a fresh list of what the turn reaches for.
export async function bandSubmit($: EngineInterface): Promise<void> {
  await update($, used, () => NONE)
}

export async function bandComplete($: EngineInterface): Promise<void> {
  await refresh($)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    await update($, used, u => ({ ...u, skills: addOnce(u.skills, e.skill.replace(/^[\w-]+:/, '')) }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    await update($, used, u => ({ ...u, agents: addOnce(u.agents, e.subagent_type ?? 'general-purpose') }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const spoke = SPOKE.exec(e.file_path)?.[1]

    if (spoke !== undefined) {
      await update($, used, u => ({ ...u, spokes: addOnce(u.spokes, spoke) }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, repo)
    const result = await read($, evals)
    const live = await read($, session)
    const reached = await read($, used)
    const build = await read($, ci)

    if (e.props.hasSurvey || (info === null && result === null && live === null)) {
      return next(e)
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)

    // The desktop and mobile apps draw SVG: ring gauges and progress rows, as in a mission board.
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const now = await $.clock.now()
      const gauges: Gauge[] = []

      if (live !== null) {
        if (live.contextPercent !== null) gauges.push({ percent: live.contextPercent, caption: 'context', icon: 'stack' })

        for (const limit of live.limits ?? []) {
          const left = timeLeft(limit.resetsAt, now)
          const name = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? '7d' : limit.kind
          gauges.push({
            percent: limit.percentUsed,
            caption: left === '' ? name : `${name} · resets in ${left}`,
            icon: limit.kind === 'seven_day' ? 'calendar' : 'clock',
          })
        }
      }

      const rows: BarRow[] = []

      if (info !== null && result !== null) {
        const fraction = result.passed / result.total
        const pct = Math.round(fraction * 100)
        const sync = `${info.ahead > 0 ? ` ↑${info.ahead}` : ''}${info.behind > 0 ? ` ↓${info.behind}` : ''}`
        const dirty = info.changed + info.untracked
        rows.push({
          label: `${info.branch}${sync} · ${dirty === 0 ? 'clean' : `${dirty} changed`}`,
          mark: pct >= 85 ? 'tick' : pct < 60 ? 'bang' : 'dot',
          fraction,
          pillWord: 'Evals',
          pillCount: `${result.passed}/${result.total}`,
          pillIcon: pct === 100 ? 'tick' : pct < 60 ? 'cross' : undefined,
          color: pct >= 85 ? INK.green : pct >= 60 ? INK.purple : INK.red,
          parts: 4,
        })
      }

      if (build !== null) {
        const isDone = build.status === 'completed'
        const isPass = isDone && build.conclusion === 'success'
        rows.push({
          label: `CI · ${build.workflow}`,
          mark: !isDone ? 'dot' : isPass ? 'tick' : 'bang',
          fraction: isDone ? 1 : 0.5,
          pillWord: !isDone ? 'Running' : isPass ? 'Done' : 'Failed',
          pillCount: '',
          pillIcon: !isDone ? undefined : isPass ? 'tick' : 'cross',
          color: !isDone ? INK.purple : isPass ? INK.green : INK.red,
          parts: 1,
          right: !isDone ? build.status.replace(/_/g, ' ') : build.conclusion,
        })
      }

      // The branch alone, when there is no eval report to draw it beside.
      const plainBranch =
        info !== null && result === null
          ? `⎇ ${info.branch} · ${info.changed + info.untracked === 0 ? 'clean' : `${info.changed} changed, ${info.untracked} untracked`}`
          : ''

      const skills: Part[][] = []

      if (reached.skills.length > 0 || reached.spokes.length > 0) {
        const group: Part[] = [
          { text: 'skill ', dim: true },
          { text: reached.skills.length > 0 ? reached.skills.join(', ') : '—', color: 'suggestion', bold: true },
        ]

        if (reached.spokes.length > 0) group.push({ text: ' › ', dim: true }, { text: reached.spokes.join(', '), color: 'merged' })
        skills.push(group)
      }

      if (reached.agents.length > 0) skills.push([{ text: 'agent ', dim: true }, { text: reached.agents.join(', '), color: 'remember' }])
      if (skills.length === 0) skills.push([{ text: 'no skill this turn', dim: true }])
      if (plainBranch !== '') skills.push([{ text: plainBranch, color: 'suggestion' }])

      return (
        <Box flexDirection="column">
          {live !== null && <Svg source={gaugeRow(shortModel(live.model), gauges)} alt={`${shortModel(live.model)} usage meters`} />}
          {rows.length > 0 && <Svg source={barRows(rows)} alt="Evals and CI progress" />}
          <Box>
            <Text>
              {joinGroups(skills).map((part, i) => (
                <Text key={String(i)} color={part.color} dimColor={part.dim} weight={part.bold ? 'semibold' : undefined}>
                  {part.text}
                </Text>
              ))}{' '}
            </Text>
            <Button key="refresh" label="↻" onPress={() => refreshNow($)} />
            <Button key="commit" label="⊙" onPress={() => $.prompt.submit({ text: COMMIT_PROMPT, asUser: true })} />
            <Button key="pr" label="⑂" onPress={() => $.prompt.submit({ text: PR_PROMPT, asUser: true })} />
          </Box>
        </Box>
      )
    }

    // Line 1: the model, every usage percentage, then the skills and agents this turn reached for.
    const first: Part[][] = []

    if (live !== null) {
      const group: Part[] = [{ text: shortModel(live.model), color: 'claude', bold: true }]
      const meters: [string, number][] = []

      if (live.contextPercent !== null) meters.push(['ctx', live.contextPercent])
      // State saved by an older version has no `limits` until the next refresh.
      for (const limit of live.limits ?? []) meters.push([LIMIT_LABEL[limit.kind] ?? limit.kind, limit.percentUsed])

      for (const [label, value] of meters) {
        const pct = Math.round(value)
        // A low fill is good, so the scale runs the other way round.
        group.push({ text: ` ${label} `, dim: true }, { text: `${pct}%`, color: level(100 - pct, 50, 20) })
      }

      first.push(group)
    }

    if (reached.skills.length > 0 || reached.spokes.length > 0) {
      const group: Part[] = [
        { text: 'skill ', dim: true },
        { text: reached.skills.length > 0 ? reached.skills.join(', ') : '—', color: 'suggestion', bold: true },
      ]

      if (reached.spokes.length > 0) {
        group.push({ text: ' › ', dim: true }, { text: reached.spokes.join(', '), color: 'merged' })
      }

      first.push(group)
    }

    if (reached.agents.length > 0) {
      first.push([{ text: 'agent ', dim: true }, { text: reached.agents.join(', '), color: 'remember' }])
    }

    if (reached.skills.length + reached.spokes.length + reached.agents.length === 0) {
      first.push([{ text: 'no skill this turn', dim: true }])
    }

    // Line 2: git branch and status, then CI and the eval tests.
    const second: Part[][] = []

    if (info !== null) {
      const group: Part[] = [{ text: `⎇ ${info.branch}`, color: 'suggestion' }]

      if (info.ahead > 0) group.push({ text: ` ↑${info.ahead}`, color: 'merged' })
      if (info.behind > 0) group.push({ text: ` ↓${info.behind}`, color: 'error' })

      second.push(group)
      second.push(
        info.changed + info.untracked === 0
          ? [{ text: 'clean', color: 'success' }]
          : [
              { text: `${info.changed} changed`, color: 'warning' },
              { text: ', ', dim: true },
              { text: `${info.untracked} untracked`, color: 'subtle' },
            ],
      )
    }

    if (build !== null) {
      second.push([{ text: 'ci ', dim: true }, ciPart(build)])
    }

    if (result !== null) {
      const pct = Math.round((result.passed / result.total) * 100)
      second.push([
        { text: 'evals ', dim: true },
        { text: `${result.passed}/${result.total} (${pct}%)`, color: level(pct, 85, 60) },
      ])
    }

    const line = (parts: Part[]) => (
      <Text>
        {parts.map((part, i) => (
          <Text key={String(i)} color={part.color} dimColor={part.dim} weight={part.bold ? 'semibold' : undefined}>
            {part.text}
          </Text>
        ))}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {line(joinGroups(first))}
        <Box>
          {line([...joinGroups(second), { text: ' ' }])}
          {/* An icon, not a word: ↻ is the refresh glyph. */}
          <Button key="refresh" label="↻" onPress={() => refreshNow($)} />
          <Button key="commit" label="⊙" onPress={() => $.prompt.submit({ text: COMMIT_PROMPT, asUser: true })} />
          <Button key="pr" label="⑂" onPress={() => $.prompt.submit({ text: PR_PROMPT, asUser: true })} />
        </Box>
      </Box>
    )
  })
}
