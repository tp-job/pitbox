import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import { INK, stackRows, statTiles } from './draw'
import type { BarRow, StackRow } from './draw'
import type { Phase, Plan, Snapshot, Used } from '../types'

const PANE = 'pitbox'
const TITLE = 'Pitbox'
const REFRESH_MS = 15_000

// Change a tag when the shape it guards changes: it declines what an earlier version stored.
const snapshot = atom({ plugin: 'pitbox', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const NO_USE: Used = { skills: [], agents: [] }
const used = atom({ plugin: 'pitbox', key: 'used' } as const, NO_USE, { shape: 'used-1' })

// Phases read from .claude/phases.json: what shows until Claude's own task list has been seen.
const phases = atom({ plugin: 'pitbox', key: 'phases' } as const, null, { shape: 'phases-1' })
// The live plan, rebuilt from Claude's task-list calls (TodoWrite, update_plan).
const plan = atom({ plugin: 'pitbox', key: 'plan' } as const, null, { shape: 'plan-1' })

type PlanArgs = {
  items?: { content?: string; status?: string }[]
  todos?: { content?: string; status?: string }[]
  advance?: boolean
  done?: number[]
  start?: number
}

function statusOf(raw: string | undefined): Phase['status'] {
  return raw === 'completed' ? 'done' : raw === 'in_progress' ? 'doing' : 'todo'
}

// Folds one task-list call into the plan, stamping when each phase started and ended.
function applyPlanCall(current: Plan | null, args: PlanArgs, now: number): Plan {
  const items = (current?.items ?? []).map(item => ({ ...item }))
  const listed = args.items ?? args.todos

  if (listed !== undefined) {
    const next: Phase[] = listed.map(entry => {
      const name = String(entry.content ?? '').trim() || 'step'
      const status = statusOf(entry.status)
      const before = items.find(item => item.name === name)

      return {
        name,
        status,
        startedAt: before?.startedAt ?? (status === 'todo' ? undefined : now),
        endedAt: status === 'done' ? (before?.endedAt ?? now) : undefined,
      }
    })

    return { items: next, startedAt: current?.startedAt ?? now }
  }

  const finish = (item: Phase) => {
    item.status = 'done'
    item.startedAt ??= now
    item.endedAt ??= now
  }
  const begin = (item: Phase) => {
    item.status = 'doing'
    item.startedAt ??= now
    item.endedAt = undefined
  }

  if (args.advance === true) {
    const doing = items.find(item => item.status === 'doing')

    if (doing !== undefined) finish(doing)
    const up = items.find(item => item.status === 'todo')

    if (up !== undefined) begin(up)
  }

  for (const n of args.done ?? []) {
    if (items[n - 1] !== undefined) finish(items[n - 1])
  }

  if (typeof args.start === 'number' && items[args.start - 1] !== undefined) begin(items[args.start - 1])

  return { items, startedAt: current?.startedAt ?? now }
}

function allDone(current: Plan | null, now: number): Plan | null {
  if (current === null) return null

  return {
    ...current,
    items: current.items.map(item => ({ ...item, status: 'done', startedAt: item.startedAt ?? now, endedAt: item.endedAt ?? now })),
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// The project's plan, one entry per phase; Claude keeps this file current as the work moves.
const PHASES_FILE = '.claude/phases.json'

async function refreshPhases($: EngineInterface, cwd: string): Promise<void> {
  try {
    const parsed = JSON.parse(await $.fs.read(`${cwd}/${PHASES_FILE}`)) as unknown
    const list = (Array.isArray(parsed) ? parsed : (parsed as { phases?: unknown }).phases) as Phase[] | undefined
    const clean = (list ?? []).filter(
      p => typeof p?.name === 'string' && (p.status === 'done' || p.status === 'doing' || p.status === 'todo'),
    )
    await update($, phases, () => (clean.length > 0 ? clean : null))
  } catch {
    // No file in this project, or it is not valid JSON: the phases block is left out.
    await update($, phases, () => null)
  }
}

// A phase plan Claude wrote out in a reply or a plan file, such as
// "## Phase 1: Fix the client hooks (`refactor/client-hooks`) — small, low risk"
// followed by bullets and a "เกณฑ์ผ่าน:" / "Exit criteria:" bullet.
const written = atom({ plugin: 'pitbox', key: 'written' } as const, null, { shape: 'written-1' })

const PHASE_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:phase|ระยะ|เฟส|stage)\s*(\d+)\s*(?:\*\*)?\s*[:：.—–-]\s*(.+?)\s*$/i
const BULLET = /^\s*(?:[-*•○◦▪]|\d+[.)])\s+(.*)$/
const CRITERIA = /^(?:\*\*)?\s*(?:เกณฑ์ผ่าน|exit criteria|done when|pass criteria|acceptance criteria)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i
const PLAN_FILE = /[\\/]plans?[\\/][^\\/]+\.md$/i

function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function parseWrittenPlan(text: string): Phase[] | null {
  const out: Phase[] = []
  let current: Phase | null = null

  for (const raw of text.split('\n')) {
    const head = PHASE_HEAD.exec(raw)

    if (head !== null) {
      let title = head[2]
      const branchMatch = /\(\s*`([^`]+)`\s*\)/.exec(title) ?? /`([\w.-]+\/[\w./-]+)`/.exec(title)

      if (branchMatch !== null) title = title.replace(branchMatch[0], ' ')

      const [main, ...rest] = title.split(/\s+[—–]\s+/)
      current = {
        name: `Phase ${head[1]}: ${plain(main)}`,
        num: Number(head[1]),
        status: 'todo',
        branch: branchMatch?.[1],
        note: rest.length > 0 ? plain(rest.join(' — ')) : undefined,
        steps: [],
      }
      out.push(current)
      continue
    }

    if (current === null) continue

    // Any other heading ends the phase it follows.
    if (/^\s*#{1,6}\s/.test(raw)) {
      current = null
      continue
    }

    const bullet = BULLET.exec(raw)

    if (bullet !== null) {
      const criteria = CRITERIA.exec(bullet[1])

      if (criteria !== null) current.criteria = plain(bullet[1].slice(criteria[0].length))
      else current.steps?.push(plain(bullet[1]))
    }
  }

  // One heading alone is a mention, not a plan.
  return out.length >= 2 ? out : null
}

// A new plan keeps the status of any phase it shares a name with.
async function keepWrittenPlan($: EngineInterface, text: string): Promise<void> {
  const parsed = parseWrittenPlan(text)

  if (parsed === null) return

  await update($, written, before =>
    parsed.map(p => {
      const same = (before ?? []).find(old => old.name === p.name)

      return same === undefined ? p : { ...p, status: same.status }
    }),
  )
}

// What each written phase's status is now: the task list naming it wins, then its branch being checked out.
function withStatus(items: Phase[], branch: string, live: Plan | null): Phase[] {
  return items.map(p => {
    const named = (live?.items ?? []).find(item =>
      new RegExp(`(?:phase|ระยะ|เฟส|stage)\\s*${p.num ?? -1}\\b`, 'i').test(item.name),
    )

    if (named !== undefined) {
      return { ...p, status: named.status, startedAt: named.startedAt, endedAt: named.endedAt }
    }

    if (p.branch !== undefined && p.branch === branch && p.status !== 'done') return { ...p, status: 'doing' }

    return p
  })
}

function addOnce(list: string[], name: string): string[] {
  return list.includes(name) ? list : [...list, name]
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    await refreshPhases($, cwd)
    const usage = await $.session.usage()
    const model = await $.session.model()
    const next: Snapshot = {
      model,
      project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? '',
      contextPercent: usage.context.percent ?? null,
      contextTokens: usage.context.tokens ?? null,
      costUsd: usage.cost?.usd ?? null,
      limits: usage.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed })),
      branch: '',
      changed: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
    }

    try {
      const ran = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { cwd })

      if (ran.exitCode === 0) {
        for (const line of ran.stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) next.branch = line.slice(14).trim()
          else if (line.startsWith('# branch.ab ')) {
            const [a, b] = line.slice(12).trim().split(' ')
            next.ahead = Math.abs(Number(a) || 0)
            next.behind = Math.abs(Number(b) || 0)
          } else if (line.startsWith('? ')) next.untracked += 1
          else if (/^[12u] /.test(line)) next.changed += 1
        }
      }
    } catch {
      // Not a git folder: the pane simply leaves the git block out.
    }

    await update($, snapshot, () => next)
  } catch {
    await update($, snapshot, () => null)
  }
}

// register.tsx hooks each of these events once for the whole plugin and calls both halves.
let stopTimer: (() => void) | undefined

export async function sidebarStart($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'pitbox', description: 'Open the Pitbox sidebar: the phase plan' })
  await refresh($)
  stopTimer?.()
  stopTimer = $.clock.every(REFRESH_MS, () => void refresh($))
  void $.ui.open({ id: PANE, title: TITLE })
}

export async function sidebarSubmit($: EngineInterface): Promise<void> {
  await update($, used, () => NO_USE)
}

// Only the main conversation's answers count: a subagent's report is not the plan.
export async function sidebarComplete($: EngineInterface, answer: string, agentId: string | undefined): Promise<void> {
  if (agentId === undefined && typeof answer === 'string') {
    await keepWrittenPlan($, answer)
  }

  await refresh($)
}

export const register: Register = on => {

  on('command.run', { command: 'pitbox' }, async $ => {
    const placed = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: placed.isPlaced
        ? 'Pitbox opened.'
        : 'Pitbox is open, but nothing on this surface can draw it right now.',
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill') {
      const name = String((e as unknown as { skill?: string }).skill ?? '').replace(/^[\w-]+:/, '')
      await update($, used, u => ({ ...u, skills: addOnce(u.skills, name) }))
    } else if (e.tool === 'Agent') {
      const kind = (e as unknown as { subagent_type?: string }).subagent_type ?? 'general-purpose'
      await update($, used, u => ({ ...u, agents: addOnce(u.agents, kind) }))
    }

    const isPlanCall = e.tool === 'TodoWrite' || e.tool.endsWith('__update_plan')
    const isWrapUp = e.tool.endsWith('__wrap_up')

    // A plan written to a plan file (plan mode) counts as a written plan.
    const filePath = (e as unknown as { file_path?: unknown }).file_path
    const content = (e as unknown as { content?: unknown }).content

    if (e.tool === 'Write' && typeof filePath === 'string' && PLAN_FILE.test(filePath) && typeof content === 'string') {
      await keepWrittenPlan($, content)
    }

    if (isPlanCall || isWrapUp) {
      const now = await $.clock.now()
      const args = e as unknown as PlanArgs
      await update($, plan, current => (isWrapUp ? allDone(current, now) : applyPlanCall(current, args, now)))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const reached = await read($, used)
    const fromFile = await read($, phases)
    const live = await read($, plan)
    const now = await $.clock.now()
    const plotted = await read($, written)
    // A written phase plan first, then Claude's task list, then the project's phases file.
    const isLive = live !== null && live.items.length > 0
    const source = plotted !== null ? "Claude's plan" : isLive ? 'task list' : '.claude/phases.json'
    const items: Phase[] | null =
      plotted !== null ? withStatus(plotted, snap?.branch ?? '', live) : isLive ? live.items : fromFile

    if (items === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No plan yet. Pitbox shows the phases Claude writes, its task list, or .claude/phases.json.</Text>
        </Box>
      )
    }

    const done = items.filter(p => p.status === 'done')
    const doing = items.filter(p => p.status === 'doing')
    const waiting = items.filter(p => p.status === 'todo')
    const current = doing[0] ?? waiting[0]
    const started = live?.startedAt ?? null
    const spent = (p: Phase) => (p.startedAt === undefined ? '' : clock((p.endedAt ?? now) - p.startedAt))

    // The plan as a whole: one bar, its pill naming the phase under way.
    const word = current === undefined ? 'Done' : current.num !== undefined ? `Phase ${current.num}` : 'Tasks'
    const overall: BarRow = {
      label: snap?.project ? snap.project : 'Plan',
      mark: current === undefined ? 'tick' : 'dot',
      fraction: (done.length + doing.length * 0.5) / items.length,
      pillWord: word,
      pillCount: `${done.length + (doing.length > 0 ? 1 : 0)}/${items.length}`,
      pillIcon: current === undefined ? 'tick' : undefined,
      color: current === undefined ? INK.green : INK.purple,
      parts: items.length,
      right: `${Math.round((done.length / items.length) * 100)}%`,
    }

    const row = (p: Phase): StackRow => {
      const isDone = p.status === 'done'
      const isDoing = p.status === 'doing'
      const time = spent(p)

      return {
        label: p.name,
        mark: isDone ? 'tick' : 'dot',
        fraction: isDone ? 1 : isDoing ? 0.5 : 0,
        pillWord: isDone ? 'Done' : isDoing ? 'Running' : 'Waiting',
        pillCount: (p.steps ?? []).length > 0 ? `${isDone ? p.steps?.length : 0}/${p.steps?.length}` : '',
        pillIcon: isDone ? 'tick' : undefined,
        color: isDone ? INK.green : isDoing ? INK.purple : '#4a505b',
        parts: Math.max(1, (p.steps ?? []).length),
        right: time === '' ? (isDone ? '100%' : isDoing ? '…' : '0%') : time,
        status: { text: isDone ? 'done' : isDoing ? 'running' : 'waiting', color: isDone ? INK.green : isDoing ? INK.purple : INK.faint },
        details: [p.branch === undefined ? '' : `⎇ ${p.branch}`, p.note ?? ''].filter(Boolean).join(' · ') || undefined,
        lines: isDone ? [] : p.steps,
        criteria: isDone ? undefined : p.criteria,
      }
    }

    const tiles = statTiles([
      { label: 'Cost', value: typeof snap?.costUsd === 'number' ? `≈$${snap.costUsd.toFixed(2)}` : '—' },
      { label: 'Tokens', value: typeof snap?.contextTokens === 'number' ? kilo(snap.contextTokens) : '—' },
      { label: 'Time', value: started === null ? '—' : clock(now - started) },
    ])
    const section = (title: string, list: Phase[]) =>
      list.length === 0 ? null : (
        <Box key={title} flexDirection="column">
          <Text dimColor>
            {title} · {list.length}
            {title === 'Finished' && reached.agents.length > 0 ? `   ×${reached.agents.length} agents` : ''}
          </Text>
          <Svg source={stackRows(list.map(row))} alt={`${title} phases: ${list.map(p => p.name).join(', ')}`} />
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text dimColor>Phases · {source} </Text>
          <Button key="refresh" label="↻" onPress={() => refresh($)} />
        </Box>
        <Svg source={tiles} alt="Cost, tokens and time" />
        <Svg source={stackRows([overall])} alt={`${overall.label}: ${overall.pillWord} ${overall.pillCount}`} />
        {section('Running', doing)}
        {section('Waiting', waiting)}
        {section('Finished', done)}
      </Box>
    )
  })
}
