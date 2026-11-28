import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import { barRows, gaugeRow, INK, timeLeft } from './draw'
import type { BarRow, Gauge } from './draw'
import { currentPlan, overallRow } from './sidebar'
import { termGauges, termRows } from './term'
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

// The macro buttons beside the band. Each has a one-letter shortcut (pressed while the band
// has the keyboard: click the band, or ctrl+x tab), a hint shown while the pointer is over it,
// and what a press does. `prompt` buttons send that text as if the person had typed it.
type Macro = {
  id: string
  /** Buttons of one group sit together; a divider separates groups. */
  group: 'band' | 'git' | 'work'
  label: string
  key: string
  /** What the button is called. */
  name: string
  /** One word for the terminal. */
  short: string
  /** What a press does, in a sentence. */
  does: string
  prompt?: string
}

const MACROS: Macro[] = [
  { id: 'refresh', short: 'refresh', group: 'band', label: '↻', key: 'r', name: 'Refresh', does: 'reload git status, CI, eval results and usage now' },
  { id: 'commit', short: 'commit', group: 'git', label: '⊙', key: 'c', name: 'Commit', does: 'ask Claude to commit your current changes', prompt: COMMIT_PROMPT },
  { id: 'pr', short: 'pr', group: 'git', label: '⑂', key: 'p', name: 'Pull request', does: 'ask Claude to open a pull request for this branch', prompt: PR_PROMPT },
  // Pushing is outward-facing, so the message asks Claude to say what it will push and wait.
  {
    id: 'push', short: 'push', group: 'git',
    label: '⇡',
    key: 'u',
    name: 'Push',
    does: 'ask Claude to push this branch; it tells you what goes where and waits for your yes',
    prompt: 'Push the current branch. Say which commits go to which remote and branch, and wait for my yes before pushing.',
  },
  { id: 'test', short: 'test', group: 'work', label: '✓', key: 't', name: 'Run tests', does: 'ask Claude to run the tests and report what fails', prompt: 'Run the tests and report what fails.' },
  { id: 'next', short: 'next', group: 'work', label: '▶', key: 'n', name: 'Continue', does: 'ask Claude to carry on with the next step of the plan', prompt: 'Continue with the next step of the plan.' },
  { id: 'review', short: 'review', group: 'work', label: '⌕', key: 'v', name: 'Review', does: 'ask Claude to review your uncommitted changes for bugs', prompt: 'Review my uncommitted changes for bugs.' },
]

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
    const reports = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let found: EvalInfo | null = null

    // The newest report that ran: one cut short (`partial`) or whose every run errored
    // (the CLI signed out, say) measured nothing, so the one before it stands.
    for (const entry of reports.slice(0, 10)) {
      const report = JSON.parse(await $.fs.read(`${cwd}/${EVAL_DIR}/${entry.name}`)) as {
        partial?: boolean
        cases?: { arms?: { with?: { passed?: boolean; error?: unknown }[] } }[]
      }
      let passed = 0
      let total = 0
      let errored = 0

      for (const testCase of report.cases ?? []) {
        for (const run of testCase.arms?.with ?? []) {
          total += 1
          passed += run.passed === true ? 1 : 0
          errored += run.error !== null && run.error !== undefined ? 1 : 0
        }
      }

      if (report.partial === true || total === 0 || errored === total) continue
      found = { passed, total, file: entry.name }
      break
    }

    await update($, evals, () => found)
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


// The macro buttons with their hover hints. A hint is a hidden Box that joins its button's
// hover group, so the surface reveals it while the pointer is over the button: no hook runs.
function macroRow(
  $: EngineInterface,
  ui: { Box: any; Button: any; Text: any },
): { buttons: JSX.Element; hints: JSX.Element } {
  const { Box, Button, Text } = ui
  const groups = (['band', 'git', 'work'] as const).map(group => MACROS.filter(macro => macro.group === group))

  const buttons = (
    <Box>
      {groups.map((group, i) => (
        <Box key={`group-${i}`}>
          {i > 0 && <Text dimColor>{' │ '}</Text>}
          {group.map(macro => (
            <Button
              key={macro.id}
              label={macro.label}
              hotkey={macro.key}
              hover={{ scope: `pb-${macro.id}` }}
              onPress={() => (macro.prompt === undefined ? refreshNow($) : $.prompt.submit({ text: macro.prompt, asUser: true }))}
            />
          ))}
        </Box>
      ))}
    </Box>
  )

  // Hidden until the pointer is over a button of the same scope.
  const hints = (
    <Box flexDirection="column">
      {MACROS.map(macro => (
        <Box key={`hint-${macro.id}`} display="none" hover={{ scope: `pb-${macro.id}`, display: 'flex' }}>
          <Text>
            <Text color="suggestion" weight="semibold">{`${macro.label} ${macro.name}`}</Text>
            <Text dimColor>{` · ${macro.does} · key `}</Text>
            <Text color="warning" weight="semibold">{macro.key}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )

  return { buttons, hints }
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
    const macros = macroRow($, { Box, Button, Text })

    // The same facts on every surface: ring gauges, progress rows, then skills and buttons.
    {
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
      } else if (info !== null) {
        // No eval report in this project: the branch still gets its own row, a status bar
        // like CI's — green and full when clean, amber when files changed.
        const sync = [info.ahead > 0 ? `↑${info.ahead}` : '', info.behind > 0 ? `↓${info.behind}` : ''].filter(Boolean).join(' ')
        const isClean = info.changed + info.untracked === 0
        rows.push({
          label: info.branch,
          mark: isClean ? 'tick' : 'dot',
          fraction: 1,
          pillWord: isClean ? 'Clean' : `${info.changed} changed`,
          pillCount: isClean || info.untracked === 0 ? '' : `+${info.untracked} new`,
          pillIcon: isClean ? 'tick' : undefined,
          color: isClean ? INK.green : INK.amber,
          parts: 1,
          right: sync === '' ? 'in sync' : sync,
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

      // Under CI: the plan as one bar, as in the sidebar (the phase list stays there).
      const wholePlan = await currentPlan($)

      if (wholePlan.items !== null) rows.push(overallRow(wholePlan.items, wholePlan.project))

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

      const model = live === null ? '' : shortModel(live.model)

      if (e.surface === 'desktop' || e.surface === 'mobile') {
        return (
          <Box flexDirection="column">
            {live !== null && <Svg source={gaugeRow(model, gauges)} alt={`${model} usage meters`} />}
            {rows.length > 0 && <Svg source={barRows(rows)} alt="Evals, CI and plan progress" />}
            <Box justifyContent="space-between">
              <Text>
              {joinGroups(skills).map((part, i) => (
                <Text key={String(i)} color={part.color} dimColor={part.dim} weight={part.bold ? 'semibold' : undefined}>
                  {part.text}
                </Text>
              ))}
            </Text>
              {macros.buttons}
            </Box>
            {macros.hints}
          </Box>
        )
      }

      // A terminal: the same card, in a border, with the buttons worded and grouped.
      const columns = Math.max(40, (e.props.bodyColumns ?? 80) - 4)

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={INK.faint} paddingX={1}>
          {live !== null && termGauges({ Box, Text }, model, gauges)}
          {rows.length > 0 && termRows({ Box, Text }, rows, columns)}
          <Box flexWrap="wrap" justifyContent="space-between" columnGap={2}>
            <Text>
              {joinGroups(skills).map((part, i) => (
                <Text key={String(i)} color={part.color} dimColor={part.dim} weight={part.bold ? 'semibold' : undefined}>
                  {part.text}
                </Text>
              ))}
            </Text>
            <Box flexWrap="wrap" columnGap={1}>
              {MACROS.map((macro, i) => (
                <Box key={`t-${macro.id}`} columnGap={1}>
                  {i > 0 && MACROS[i - 1].group !== macro.group && <Text color={INK.faint}>│</Text>}
                  <Button
                    key={macro.id}
                    label={macro.short}
                    hotkey={macro.key}
                    plain
                    onPress={() => (macro.prompt === undefined ? refreshNow($) : $.prompt.submit({ text: macro.prompt, asUser: true }))}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }
  })
}
