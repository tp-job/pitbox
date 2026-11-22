// The chat band's values.
export type RepoInfo = {
  branch: string
  ahead: number
  behind: number
  changed: number
  untracked: number
}

export type EvalInfo = {
  passed: number
  total: number
  file: string
}

export type SessionInfo = {
  model: string
  usd: number | null
  contextPercent: number | null
  /** Plan windows: `five_hour`, `seven_day`, a gateway's `spend_limit`. */
  limits: { kind: string; percentUsed: number }[]
}

/** The latest GitHub Actions run on the current branch, from `gh run list`. */
export type CiInfo = {
  workflow: string
  status: string
  conclusion: string
}

/** What the current (or last) turn reached for: skills, hub spokes opened, subagents. */
export type UsedInfo = {
  skills: string[]
  spokes: string[]
  agents: string[]
}

// The sidebar's values.
export type Call = { id: string; tool: string; detail: string; isDone: boolean; isError: boolean }

export type Snapshot = {
  model: string
  project: string
  contextPercent: number | null
  contextTokens: number | null
  costUsd: number | null
  limits: { kind: string; percentUsed: number }[]
  branch: string
  changed: number
  untracked: number
  ahead: number
  behind: number
}

/** One phase of a plan. `startedAt` and `endedAt` are `$.clock.now()` milliseconds. */
export type Phase = {
  name: string
  status: 'done' | 'doing' | 'todo'
  note?: string
  startedAt?: number
  endedAt?: number
  /** From a written plan: its number, branch, steps and exit criteria. */
  num?: number
  branch?: string
  steps?: string[]
  criteria?: string
}

/** The plan Claude is working through, kept from its own task-list calls (or read from a file). */
export type Plan = { items: Phase[]; startedAt: number | null }

export type Used = { skills: string[]; agents: string[] }

declare module 'claude-code' {
  interface PluginState {
    'pitbox': {
      bandRepo: RepoInfo | null
      bandEvals: EvalInfo | null
      bandSession: SessionInfo | null
      bandCi: CiInfo | null
      bandUsed: UsedInfo
      calls: Shaped<Call[]>
      snapshot: Shaped<Snapshot | null>
      used: Shaped<Used>
      phases: Shaped<Phase[] | null>
      plan: Shaped<Plan | null>
      written: Shaped<Phase[] | null>
    }
  }
}
