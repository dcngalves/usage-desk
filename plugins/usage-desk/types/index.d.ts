export type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number; replies: number }
export type ChatRow = Tokens & { id: string; title: string; project: string; weight: number; lastAt: number; share: number }
export type ProjectRow = { name: string; share: number; chats: number }
export type WindowScan = Tokens & { start: number; chats: ChatRow[]; chatCount: number; projects: ProjectRow[] }
export type Group = { name: string; calls: number; tokens: number }
export type TimelineRow = { id: string; kind: 'reply' | 'job'; tool: string; label: string; at: number; tokens: number; thinking: number; reread: number; fresh: number; isError: boolean }
export type ChatScan = {
  found: boolean
  yourMessages: number
  replies: number
  toolCalls: number
  yourTokens: number
  claudeTokens: number
  thinkingTokens: number
  toolInputTokens: number
  toolResultTokens: number
  tools: Group[]
  connectors: Group[]
  files: { path: string; reads: number; tokens: number }[]
  largest: { tool: string; label: string; tokens: number }[]
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  coldRebuilds: number
  coldTokens: number
  ttl: string
  subagents: { id: string; tokens: number; replies: number }[]
  compactions: number
  timeline: TimelineRow[]
  appTokens: number
  cost: number
  subagentCost: number
  subagentTokens: number
}
export type Scan = { at: number; five: WindowScan; week: WindowScan; chat: ChatScan; plan: { at: number; five: number; week: number } | null }

export type Limit = { percent: number; resetsAt: string; isLive: boolean; readAt: number }
export type Category = { name: string; tokens: number; color: string; kind: string }
export type Square = { name: string; isFilled: boolean; fullness: number }
export type Named = { name: string; tokens: number; detail?: string }
export type Breakdown = {
  categories: Category[]
  grid: Square[][]
  memory: Named[]
  mcp: Named[]
  skills: Named[]
  agents: Named[]
  model: string
}
export type Snapshot = {
  chatTokens: number
  chatWindow: number
  chatPercent: number
  five: Limit | null
  week: Limit | null
  breakdown: Breakdown | null
  scan: Scan | null
  model: string
  cost: number
  startedAt: number
}

export type Panel = { open: string; detail: string; chat: string; confirm: string; showActivity: boolean; showLooks: boolean; notice: string; job: string; moreJobs: boolean; isRenaming: boolean }
export type Activity = { id: string; tool: string; label: string; agent: string; isDone: boolean; isFailed: boolean; at: number }
export type Live = {
  isWorking: boolean
  recent: Activity[]
  counts: Record<string, number>
  files: string[]
  skills: string[]
  connectors: Record<string, number>
}
export type AgentRun = {
  id: string
  agentId: string
  type: string
  description: string
  model: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number
  contextTokens: number
  tokens: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  steps: number
  current: string
}
export type Cache = { lastEnd: number; ttlMs: number; isKnown: boolean; tokens: number }
export type Warm = { isOn: boolean; startedAt: number; pings: number; isSending: boolean; failures: number; note: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-desk': {
      snapshot: Shaped<Snapshot>
      panel: Shaped<Panel>
      live: Shaped<Live>
      agents: Shaped<AgentRun[]>
      cache: Shaped<Cache>
      warm: Shaped<Warm>
      now: number
      costume: string
      agentName: string
    }
  }
}
