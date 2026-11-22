import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Call, Phase, Plan, Snapshot, Used } from '../types'

const PANE = 'pitbox'
const TITLE = 'Pitbox'
const REFRESH_MS = 15_000
const KEEP_CALLS = 200

// Change a tag when the shape it guards changes: it declines what an earlier version stored.
const calls = atom({ plugin: 'pitbox', key: 'calls' } as const, [], { shape: 'calls-1' })
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

// What a call was about, in a few characters: its command, file or query.
function detailOf(e: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'pattern', 'description', 'skill', 'subagent_type']) {
    const value = e[key]

    if (typeof value === 'string' && value !== '') {
      return value.replace(/\s+/g, ' ').slice(0, 60)
    }
  }

  return ''
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
  await $.command.register({ name: 'pitbox', description: 'Open the Pitbox sidebar: the phase plan and recent tool calls' })
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
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    const call: Call = { id, tool: e.tool, detail: detailOf(e as unknown as Record<string, unknown>), isDone: false, isError: false }
    await update($, calls, list => [...list, call].slice(-KEEP_CALLS))

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

    const ran = await next(e)
    const isError = ran.deny === undefined && (ran as { isError?: boolean }).isError === true
    await update($, calls, list => list.map(one => (one.id === id ? { ...one, isDone: true, isError } : one)))

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const list = await read($, calls)
    const reached = await read($, used)
    const fromFile = await read($, phases)
    const live = await read($, plan)
    const now = await $.clock.now()
    const plotted = await read($, written)
    // A written phase plan first, then Claude's task list, then the project's phases file.
    const isLive = live !== null && live.items.length > 0
    const source = plotted !== null ? "Claude's plan" : isLive ? 'task list' : 'from .claude/phases.json'
    const items: Phase[] | null =
      plotted !== null ? withStatus(plotted, snap?.branch ?? '', live) : isLive ? live.items : fromFile
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 22)

    return (
      <Box flexDirection="column">
        {items !== null && (
          <Box flexDirection="column" gap={1}>
            {(() => {
              const done = items.filter(p => p.status === 'done').length
              const doing = items.filter(p => p.status === 'doing')
              const waiting = items.filter(p => p.status === 'todo')
              const finished = items.filter(p => p.status === 'done')
              const pct = Math.round((done / items.length) * 100)
              const current = doing[0] ?? waiting[0]
              const label =
                current === undefined
                  ? 'Complete'
                  : current.num !== undefined
                    ? `Phase ${current.num}`
                    : current.name.split(' ').slice(0, 3).join(' ')
              const started = live?.startedAt ?? null
              const barWidth = Math.max(12, Math.min(44, (e.bodyColumns ?? 36) - 4))
              const fill = (p: Phase): { text: string; color: Color } => {
                if (p.status === 'done') return { text: '█'.repeat(barWidth), color: 'success' }
                if (p.status === 'doing') {
                  const half = Math.round(barWidth / 2)

                  return { text: '█'.repeat(half) + '░'.repeat(barWidth - half), color: 'warning' }
                }

                return { text: '░'.repeat(barWidth), color: 'subtle' }
              }
              const row = (p: Phase) => {
                const tag = p.status === 'done' ? 'done' : p.status === 'doing' ? 'running' : 'waiting'
                const tagColor: Color = p.status === 'done' ? 'success' : p.status === 'doing' ? 'warning' : 'subtle'
                const spent = p.startedAt === undefined ? '' : ` ${clock((p.endedAt ?? now) - p.startedAt)}`
                const track = fill(p)

                return (
                  <Box key={p.name} flexDirection="column">
                    <Text weight="semibold">{p.name}</Text>
                    <Text>
                      <Text color={tagColor}>{tag}</Text>
                      <Text dimColor>{spent}</Text>
                      {p.branch !== undefined && <Text color="suggestion"> · ⎇ {p.branch}</Text>}
                      {p.note !== undefined && p.note !== '' && <Text dimColor> · {p.note}</Text>}
                    </Text>
                    {(p.steps ?? []).slice(0, 6).map((step, i) => (
                      <Text key={`s${i}`} dimColor={p.status !== 'doing'}>
                        {'  '}
                        {p.status === 'done' ? '✓' : '·'} {step}
                      </Text>
                    ))}
                    {(p.steps ?? []).length > 6 && <Text dimColor>{`  +${(p.steps ?? []).length - 6} more`}</Text>}
                    {p.criteria !== undefined && (
                      <Text>
                        <Text color="warning">{'  '}เกณฑ์ผ่าน: </Text>
                        <Text dimColor>{p.criteria}</Text>
                      </Text>
                    )}
                    <Text color={track.color}>{track.text}</Text>
                  </Box>
                )
              }

              return (
                <Box flexDirection="column" gap={1}>
                  <Text dimColor>Phases ({source})</Text>
                  <Text weight="bold">{snap?.project ? snap.project : 'Project'}</Text>

                  <Box gap={1}>
                    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1}>
                      <Text dimColor>Cost</Text>
                      <Text weight="bold">{typeof snap?.costUsd === 'number' ? `≈$${snap.costUsd.toFixed(2)}` : '—'}</Text>
                    </Box>
                    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1}>
                      <Text dimColor>Tokens</Text>
                      <Text weight="bold">{typeof snap?.contextTokens === 'number' ? kilo(snap.contextTokens) : '—'}</Text>
                    </Box>
                    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1}>
                      <Text dimColor>Time</Text>
                      <Text weight="bold">{started === null ? '—' : clock(now - started)}</Text>
                    </Box>
                  </Box>

                  <Text>
                    <Text color={doing.length > 0 ? 'warning' : 'success'}>● </Text>
                    <Text backgroundColor="suggestion" color="inverseText" weight="semibold">
                      {` ${label} ${Math.min(done + (doing.length > 0 ? 1 : 0), items.length)}/${items.length} `}
                    </Text>
                    <Text dimColor>  {pct}%</Text>
                    {reached.agents.length > 0 && <Text color="remember">  ×{reached.agents.length}</Text>}
                  </Text>

                  {doing.length > 0 && (
                    <Box flexDirection="column" gap={1}>
                      <Text dimColor>Running · {doing.length}</Text>
                      {doing.map(row)}
                    </Box>
                  )}
                  {waiting.length > 0 && (
                    <Box flexDirection="column" gap={1}>
                      <Text dimColor>Waiting · {waiting.length}</Text>
                      {waiting.map(row)}
                    </Box>
                  )}
                  {finished.length > 0 && (
                    <Box flexDirection="column" gap={1}>
                      <Text dimColor>Finished · {finished.length}</Text>
                      {finished.map(row)}
                    </Box>
                  )}
                </Box>
              )
            })()}
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor>recent tool calls ({list.length})</Text>
          {list.length === 0 && <Text dimColor>none yet</Text>}
          {list.slice(-room).map(call => (
            <Text key={call.id} color={call.isError ? 'error' : undefined} dimColor={call.isDone && !call.isError}>
              {call.isDone ? (call.isError ? '✗' : '✓') : '…'} {call.tool}
              {call.detail === '' ? '' : ` ${call.detail}`}
            </Text>
          ))}
        </Box>

        <Box>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          <Text> </Text>
          <Button key="clear" label="Clear calls" onPress={() => update($, calls, () => [])} />
        </Box>
      </Box>
    )
  })
}
