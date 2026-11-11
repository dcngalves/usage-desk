import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Activity, AgentRun, Breakdown, Cache, Category, ChatRow, Limit, Live, Panel, Scan, Snapshot, TimelineRow, Warm, WindowScan } from '../types'
import { MASCOT_CSS, mascot } from './mascot'

const PANE = 'usage-desk'
const TITLE = 'Usage Desk'
const FIVE_H = 5 * 3600_000
const WEEK = 7 * 24 * 3600_000
const FIVE_M = 5 * 60_000
const ONE_H = 3600_000

// Keep warm: one small ping shortly before the cache goes cold. It uses a little of
// the limit, so it has a hard stop and ends the moment the person sends a message.
const WARM_LEAD = 45_000
const WARM_MAX_PINGS = 12
const WARM_MAX_MS = 2 * ONE_H
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'bridge', 'slack-ping'])
const WARM_PROMPT = 'Reply with the single word: ok'

const FONT = "ui-sans-serif,-apple-system,'Segoe UI',sans-serif"
const DEFAULT_NAME = 'Main agent'
const FIVE_COLOR = '#378ADD'
const WEEK_COLOR = '#7F77DD'
const TRACK = 'rgba(128,128,128,.22)'
const BAD = '#D0453F'
const GOOD = '#3B9C5F'

const COSTUMES = [
  { value: 'other', label: 'Classic owl' },
  { value: 'fable', label: 'Astronaut' },
  { value: 'heavy', label: 'Detective' },
  { value: 'careful', label: 'Engineer' },
  { value: 'medium', label: 'Chef' },
  { value: 'light', label: 'Racer' },
  { value: 'explore', label: 'Pirate' },
  { value: 'science', label: 'Scientist' },
]

const STATE = { plugin: 'usage-desk' } as const
const snapshot = atom({ ...STATE, key: 'snapshot' } as const, { chatTokens: 0, chatWindow: 0, chatPercent: 0, five: null, week: null, breakdown: null, scan: null, model: '', cost: 0, startedAt: 0 } as Snapshot, { shape: 'snapshot-4' })
const panel = atom({ ...STATE, key: 'panel' } as const, { open: '', detail: '', chat: '', confirm: '', showActivity: true, showLooks: false, notice: '', job: '', moreJobs: false, isRenaming: false } as Panel, { shape: 'panel-4' })
const live = atom({ ...STATE, key: 'live' } as const, { isWorking: false, recent: [], counts: {}, files: [], skills: [], connectors: {} } as Live, { shape: 'live-1' })
const agents = atom({ ...STATE, key: 'agents' } as const, [] as AgentRun[], { shape: 'agents-1' })
const cache = atom({ ...STATE, key: 'cache' } as const, { lastEnd: 0, ttlMs: FIVE_M, isKnown: false, tokens: 0 } as Cache, { shape: 'cache-1' })
const warm = atom({ ...STATE, key: 'warm' } as const, { isOn: false, startedAt: 0, pings: 0, isSending: false, failures: 0, note: '' } as Warm, { shape: 'warm-1' })
const now = atom({ ...STATE, key: 'now' } as const, 0)
const costume = atom({ ...STATE, key: 'costume' } as const, 'other')
const agentName = atom({ ...STATE, key: 'agentName' } as const, DEFAULT_NAME)

// Module variables start over on a reload; everything drawn lives in the atoms above.
let sid = ''
let isPinging = false
let isScanning = false
// Python's command differs by system: python3 on Mac and Linux, often python or py on Windows.
let python: string[] | null = null
let lastExactAt = 0
let isOpenPending = false
const EXACT_EVERY = 2 * 60_000

// Bookkeeping must never stand between Claude and a tool or a prompt.
const quiet = (work: Promise<unknown>) => work.catch(() => undefined)

// ---------- Words and numbers

export const cleanName = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 28) || DEFAULT_NAME

export const fmtTokens = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const replyWord = (n: number) => `${n} repl${n === 1 ? 'y' : 'ies'}`
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const resetWords = (iso: string, at: number): string => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || !iso) return ''
  const ms = t - at
  if (ms <= 0) return 'resetting'
  const h = Math.floor(ms / ONE_H)
  if (h >= 24) return `resets ${Math.floor(h / 24)}d ${h % 24}h`
  if (h >= 1) return `resets ${h}h ${Math.floor((ms % ONE_H) / 60_000)}m`
  return `resets ${Math.ceil(ms / 60_000)}m`
}
const agoWords = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const shortLabel = (label: string) => (/^[/~]/.test(label) ? baseName(label) : label).slice(0, 60)
export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id || 'Claude'
  const family = m[1] ?? ''
  return `${family[0]?.toUpperCase() ?? ''}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
const friendlyTool = (tool: string): string => {
  if (!tool.startsWith('mcp__')) return tool
  const [, server = '', name = ''] = tool.split('__')
  return `${server.replace(/^plugin_[^_]*_/, '')}: ${name.replace(/_/g, ' ')}`
}
// Tool names mean little to most people: what Claude did, in plain words.
const JOBS: Record<string, string> = {
  Read: 'Read a file', Edit: 'Edited a file', MultiEdit: 'Edited a file', NotebookEdit: 'Edited a file', Write: 'Wrote a file',
  Grep: 'Searched inside files', Glob: 'Looked for files', WebSearch: 'Searched online', WebFetch: 'Opened a web page',
  Bash: 'Ran a command', Agent: 'Started a helper', Task: 'Started a helper', Skill: 'Used a skill', AskUserQuestion: 'Asked you a question', Artifact: 'Made a page',
}
const APPS: [RegExp, string][] = [[/chrome/i, 'Chrome'], [/browser/i, 'the browser'], [/gmail/i, 'Gmail'], [/calendar/i, 'Calendar'], [/drive/i, 'Google Drive'], [/sheets/i, 'Google Sheets'], [/docs/i, 'Google Docs'], [/slack/i, 'Slack'], [/notion/i, 'Notion'], [/figma/i, 'Figma'], [/linear/i, 'Linear']]
export const appName = (server: string): string => {
  const named = APPS.find(([re]) => re.test(server))?.[1]
  if (named) return named
  if (/^[0-9a-f]{8}-/i.test(server)) return 'a connected app'
  return server.replace(/^plugin_[^_]*_/, '').replace(/[-_]/g, ' ')
}
// The app's own housekeeping and tool lookups are not jobs anyone asked for.
export const isHousekeeping = (tool: string): boolean => /^mcp__(ccd_|plugin-authoring|terminal__read)/.test(tool) || /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|Monitor|ListAgents)$/.test(tool)
export const jobOf = (tool: string): string => {
  if (JOBS[tool]) return JOBS[tool] as string
  if (tool.startsWith('mcp__')) return `Used ${appName(tool.split('__')[1] ?? '')}`
  return `Used ${tool}`
}
const WORK: Record<string, string> = { Read: 'Reading files', Bash: 'Running commands', WebFetch: 'Opening web pages', WebSearch: 'Searching online', Grep: 'Searching inside files', Glob: 'Looking for files', Skill: 'Using skills', Agent: 'Starting helpers', Edit: 'Editing files', Write: 'Writing files' }
const workOf = (tool: string): string => WORK[tool] ?? (tool.startsWith('mcp__') ? jobOf(tool) : tool)
export const jobSummary = (counts: Record<string, number>): string => {
  const total: Record<string, number> = {}
  for (const [tool, n] of Object.entries(counts)) {
    if (isHousekeeping(tool)) continue
    const job = jobOf(tool)
    total[job] = (total[job] ?? 0) + n
  }
  return Object.entries(total).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([job, n]) => `${job} × ${n}`).join(' · ')
}

const connectorOf = (tool: string): string => (tool.startsWith('mcp__') ? (tool.split('__')[1] ?? '') : '')

// The label a tool call gets in the live list. Paths and searches, never file contents.
export const labelOf = (e: Record<string, unknown>): string => {
  for (const key of ['file_path', 'path', 'notebook_path', 'url', 'query', 'pattern', 'description', 'skill', 'command']) {
    const v = e[key]
    if (typeof v === 'string' && v) return shortLabel(v.split('\n')[0] ?? '')
  }
  return ''
}

// /context names its colours by theme key; a drawing needs real ones.
const THEME: Record<string, string> = {
  promptBorder: '#888780', inactive: '#6B6B66', permission: '#7F77DD', planMode: '#1D9E75', autoAccept: '#A06CD5',
  warning: '#D9A441', success: '#3B9C5F', error: '#D0453F', claude: '#D97757', suggestion: '#378ADD', bashBorder: '#D45D9B',
  ide: '#4F86C6', remember: '#378ADD', fastMode: '#E07B39', text: '#B5B5B0', subtle: '#9A9A96', secondaryText: '#9A9A96',
  merged: '#A06CD5', professionalBlue: '#378ADD', chromeYellow: '#D9A441',
}
const SPARE = ['#D97757', '#378ADD', '#1D9E75', '#7F77DD', '#D9A441', '#D45D9B', '#4F86C6', '#A06CD5']
export const hexOf = (key: string): string => {
  if (key.startsWith('#')) return key
  if (THEME[key]) return THEME[key] as string
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 997
  return SPARE[h % SPARE.length] as string
}

// The Context side panel's colours, so the two read the same.
const CATEGORY: [RegExp, string][] = [
  [/server instructions/i, '#8E8E8A'],
  [/message/i, '#3B82F6'],
  [/system tools/i, '#EA6A2A'],
  [/mcp tools/i, '#10B981'],
  [/system prompt/i, '#E09F1F'],
  [/skill/i, '#B8B8B4'],
  [/memory/i, '#A06CD5'],
  [/agent/i, '#D45D9B'],
  [/buffer|compact/i, '#6F6F6B'],
  [/free/i, '#3A3A38'],
]
export const categoryColor = (name: string): string => CATEGORY.find(([re]) => re.test(name))?.[1] ?? hexOf(name)
const categoryRank = (c: Category): number => (c.kind === 'free' ? 2 : c.kind === 'buffer' ? 1 : 0)
export const categoryOrder = (x: Category, y: Category): number => categoryRank(x) - categoryRank(y) || y.tokens - x.tokens

// List prices per million tokens (input, output, cache read, 1-hour cache write), checked 2026-11-05.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]
const costOf = (model: string, t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number => {
  const q = PRICES.find(([re]) => re.test(model))?.[1] ?? [4, 20, 0.2, 8]
  return (t.input * q[0] + t.output * q[1] + t.cacheRead * q[2] + t.cacheWrite * q[3]) / 1e6
}
const fmtCost = (usd: number): string => `$${usd >= 100 ? Math.round(usd) : usd.toFixed(2)}`
const clockTime = (ms: number): string => {
  const sec = Math.floor(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : `${m}:${String(sec % 60).padStart(2, '0')}`
}

// ---------- Reading the data

export const limitOf = (usage: SessionUsage, kind: string, fallback: number | undefined, fallbackAt: number, at: number): Limit | null => {
  const r = usage.rateLimits.find(x => x.kind === kind)
  if (r) {
    const resetAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    // The figure is from the last reply. Once its window has reset, it no longer holds.
    if (Number.isFinite(resetAt) && resetAt <= at) return { percent: 0, resetsAt: '', isLive: true, readAt: 0 }
    return { percent: r.percentUsed, resetsAt: r.resetsAt ?? '', isLive: true, readAt: 0 }
  }
  const length = kind === 'five_hour' ? FIVE_H : WEEK
  if (typeof fallback === 'number' && fallbackAt > 0 && at - fallbackAt < length) return { percent: fallback, resetsAt: '', isLive: false, readAt: fallbackAt }
  return null
}

const toBreakdown = (usage: SessionUsage): Breakdown | null => {
  const b = usage.context.breakdown
  if (!b) return null
  return {
    categories: b.categories.filter(c => c.kind !== 'deferred').map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    grid: b.gridRows.map(row => row.map(s => ({ name: s.categoryName, isFilled: s.isFilled, fullness: s.squareFullness }))),
    memory: b.memoryFiles.map(f => ({ name: baseName(f.path), tokens: f.tokens, detail: f.type })),
    mcp: Object.values(
      b.mcpTools.filter(t => t.isLoaded).reduce<Record<string, { name: string; tokens: number; detail: string; n: number }>>((all, t) => {
        const row = all[t.serverName] ?? { name: t.serverName, tokens: 0, detail: '', n: 0 }
        row.tokens += t.tokens
        row.n += 1
        row.detail = plural(row.n, 'tool')
        all[t.serverName] = row
        return all
      }, {}),
    ).map(({ name, tokens, detail }) => ({ name, tokens, detail })),
    skills: (b.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens })),
    agents: b.agents.map(a => ({ name: a.agentType, tokens: a.tokens })),
    model: b.model,
  }
}

const windowStart = (limit: Limit | null, length: number, at: number): number => {
  const t = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return Number.isFinite(t) && t > at ? t - length : at - length
}

async function runScan($: EngineInterface, five: number, week: number): Promise<Scan | null> {
  if (isScanning) return null
  isScanning = true
  try {
    const args = ['-I', `${$.plugin.root}/bin/scan.py`, sid, String(Math.floor(five)), String(Math.floor(week))]
    for (const cmd of python ? [python] : [['python3'], ['python'], ['py', '-3']]) {
      try {
        const out = await $.process.run([...cmd, ...args])
        const scan = JSON.parse(String(out.stdout)) as Scan
        python = cmd
        return scan
      } catch {
        if (python) return null
      }
    }
    return null
  } catch {
    return null
  } finally {
    isScanning = false
  }
}

// Reads what changes often for free; the breakdown and the log scan only when asked.
async function refresh($: EngineInterface, deep: boolean, exact = false) {
  const at = await $.clock.now()
  // `full` counts as /context does and matches the Context panel, one count per tool and
  // file, so it runs only for an open chat section. The closed bar keeps the free estimate.
  const isExact = exact || (deep && (await read($, panel)).open === 'chat' && at - lastExactAt >= EXACT_EVERY)
  if (isExact) lastExactAt = at
  const usage = await $.session.usage(deep ? { breakdown: isExact ? 'full' : 'summary' } : undefined)
  const prev = await read($, snapshot)
  const plan = prev.scan?.plan
  let five = limitOf(usage, 'five_hour', plan?.five, plan?.at ?? 0, at)
  let week = limitOf(usage, 'seven_day', plan?.week, plan?.at ?? 0, at)
  let scan = prev.scan
  if (deep) {
    const fresh = await runScan($, windowStart(five, FIVE_H, at), windowStart(week, WEEK, at))
    if (fresh) {
      scan = fresh
      five = limitOf(usage, 'five_hour', fresh.plan?.five, fresh.plan?.at ?? 0, at)
      week = limitOf(usage, 'seven_day', fresh.plan?.week, fresh.plan?.at ?? 0, at)
    }
  }
  await update($, snapshot, s => ({
    ...s,
    chatTokens: usage.context.tokens ?? s.chatTokens,
    chatWindow: usage.context.window || s.chatWindow,
    chatPercent: usage.context.percent ?? s.chatPercent,
    five,
    week,
    scan,
    // An open section keeps its exact counts until the next exact read.
    breakdown: deep && (isExact || at - lastExactAt >= EXACT_EVERY || !s.breakdown) ? (toBreakdown(usage) ?? s.breakdown) : s.breakdown,
    cost: usage.cost?.usd ?? s.cost,
    startedAt: usage.startedAt || s.startedAt,
    model: usage.context.breakdown?.model || s.model,
  }))
  await update($, now, () => at)
}
// While Claude works, keep the list of jobs current without a new breakdown.
async function rescan($: EngineInterface) {
  const at = await $.clock.now()
  const s = await read($, snapshot)
  const fresh = await runScan($, windowStart(s.five, FIVE_H, at), windowStart(s.week, WEEK, at))
  if (fresh) await update($, snapshot, x => ({ ...x, scan: fresh }))
}
const refreshQuietly = ($: EngineInterface, deep: boolean, exact = false) => refresh($, deep, exact).catch(() => undefined)

// ---------- Explanations, written from what was measured

export type Fix = { key: string; label: string; act: 'compact' | 'handoff' | 'warm' | 'none' }
export type Why = { lines: string[]; rows: { name: string; value: string; note?: string }[]; fixes: Fix[] }

const HANDOFF_PROMPT = 'Write a short handoff for a fresh chat: the goal, what is done, what is left, and the files that matter. Keep it under 200 words.'

// Every reply re-reads the whole chat, so what matters is its size, not its share of the window.
const BIG_CHAT = 150_000
const isBigChat = (s: Snapshot): boolean => s.chatTokens >= BIG_CHAT || s.chatPercent >= 50

export function explain(name: string, tokens: number, s: Snapshot): Why {
  const c = s.scan?.chat
  const b = s.breakdown
  const low = name.toLowerCase()
  const percent = s.chatWindow ? Math.round((tokens / s.chatWindow) * 100) : 0
  const lead = `${fmtTokens(tokens)} tokens, ${percent}% of this chat's space.`
  const isBig = isBigChat(s)
  if (low.includes('message') && c) {
    const avg = c.replies ? Math.round(c.cacheRead / c.replies) : 0
    const total = c.yourTokens + c.claudeTokens + c.thinkingTokens + c.toolInputTokens + c.toolResultTokens + c.appTokens
    const top = [
      { n: 'Results of jobs', v: c.toolResultTokens },
      { n: 'Job requests', v: c.toolInputTokens },
      { n: 'Your messages', v: c.yourTokens },
      { n: "Claude's replies", v: c.claudeTokens },
      { n: 'Thinking', v: c.thinkingTokens },
      { n: 'Reminders the app adds', v: c.appTokens },
    ].sort((x, y) => y.v - x.v)
    const main = top[0]
    const lines = [
      lead,
      `This chat holds ${plural(c.yourMessages, 'message')} from you and ${plural(c.toolCalls, 'job')} Claude did. Claude re-reads all of it on every reply, about ${fmtTokens(avg)} tokens each time, across ${replyWord(c.replies)} so far.`,
    ]
    if (main && total) lines.push(`The biggest part is ${main.n.toLowerCase()}, about ${Math.round((main.v / total) * 100)}%. These parts are estimates and will not add up exactly to the total.`)
    if (c.coldRebuilds) lines.push(`The cache went cold ${plural(c.coldRebuilds, 'time')}, which rewrote ${fmtTokens(c.coldTokens)} tokens at the higher price.`)
    const fixes: Fix[] = []
    if (isBig) fixes.push({ key: 'compact', label: 'Compact now', act: 'compact' }, { key: 'handoff', label: 'Draft a handoff', act: 'handoff' })
    else lines.push(`Nothing to fix yet. Compacting pays off more once a chat passes about ${fmtTokens(BIG_CHAT)} tokens.`)
    return { lines, fixes, rows: [...top.map(t => ({ name: t.n, value: `~${fmtTokens(t.v)}` })), ...c.largest.slice(0, 4).map(l => ({ name: `${workOf(l.tool)}${l.label ? ` · ${shortLabel(l.label)}` : ''}`, value: `~${fmtTokens(l.tokens)}`, note: 'largest' }))] }
  }
  if (low.includes('mcp') && b) {
    return {
      lines: [lead, `${plural(b.mcp.length, 'connector')} loaded tool descriptions here, and they are re-read on every reply even when unused. Turn off the ones this chat does not need.`],
      fixes: [],
      rows: [...b.mcp].sort((x, y) => y.tokens - x.tokens).map(m => ({ name: m.name, value: fmtTokens(m.tokens), note: m.detail })),
    }
  }
  if (low.includes('memory') && b) {
    return { lines: [lead, 'These instruction files load into every chat, so trimming them saves tokens everywhere.'], fixes: [], rows: [...b.memory].sort((x, y) => y.tokens - x.tokens).map(m => ({ name: m.name, value: fmtTokens(m.tokens), note: m.detail })) }
  }
  if (low.includes('skill') && b) {
    return { lines: [lead, 'Each installed skill adds a short description here. Disabling plugins you never use shrinks it.'], fixes: [], rows: [...b.skills].sort((x, y) => y.tokens - x.tokens).slice(0, 12).map(m => ({ name: m.name, value: fmtTokens(m.tokens) })) }
  }
  if (low.includes('agent') && b) {
    return { lines: [lead, 'Descriptions of the agent types Claude can start.'], fixes: [], rows: [...b.agents].sort((x, y) => y.tokens - x.tokens).map(m => ({ name: m.name, value: fmtTokens(m.tokens) })) }
  }
  if (low.includes('free')) return { lines: [`${fmtTokens(tokens)} tokens are still free in this chat.`], fixes: [], rows: [] }
  if (low.includes('buffer') || low.includes('compact')) return { lines: [lead, 'Space held back so Claude can summarise the chat when it fills up. You cannot use it for messages.'], fixes: [], rows: [] }
  if (low.includes('system prompt')) return { lines: [lead, "Claude's built-in instructions. They load in every chat and you cannot trim them."], fixes: [], rows: [] }
  if (low.includes('tool')) return { lines: [lead, 'Descriptions of the built-in tools. They load in every chat and you cannot trim them.'], fixes: [], rows: [] }
  return { lines: [lead], fixes: [], rows: [] }
}

// Why one reply or one job took the tokens it did, from that request's own figures.
export function explainRow(row: TimelineRow): string[] {
  const lines: string[] = []
  const reread = row.reread > 0 ? `To do this, Claude also re-read ${fmtTokens(row.reread)} tokens of the chat from the cache. Those re-reads cost far less per token than new text, but they repeat on every reply.` : ''
  if (row.kind === 'reply') {
    const written = row.tokens - row.thinking
    lines.push(row.thinking > 0 ? `Claude produced ${fmtTokens(row.tokens)} tokens: about ${fmtTokens(written)} of writing and ${fmtTokens(row.thinking)} of thinking first.` : `Claude wrote ${fmtTokens(row.tokens)} tokens for this reply.`)
    if (row.fresh > 0) lines.push(`${fmtTokens(row.fresh)} tokens were new to the chat at that point, such as your message and any job results.`)
    if (reread) lines.push(reread)
    if (row.thinking > written && row.thinking > 200) lines.push('Most of this was thinking. A lower effort setting usually means less of it.')
  } else {
    const job = jobOf(row.tool).toLowerCase()
    lines.push(`About ${fmtTokens(row.tokens)} tokens went into the chat when Claude ${job}. That counts the request and what came back. It is an estimate from the text's length.`)
    lines.push('It stays in the chat, so Claude re-reads it on every later reply until the chat is compacted.')
    if (reread) lines.push(reread)
    if (row.tokens > 5000) lines.push(row.tool === 'Read' ? 'This is a big file. Pointing Claude to the part you need would use less.' : 'This is a big result. Asking for something narrower would use less.')
    if (row.isError) lines.push('This job failed, so those tokens brought nothing useful back.')
  }
  return lines
}

export function explainFiles(s: Snapshot): Why {
  const c = s.scan?.chat
  if (!c) return { lines: ['No log for this chat yet.'], fixes: [], rows: [] }
  const repeat = c.files.filter(f => f.reads > 1)
  const lines = [`Claude read ${plural(c.files.length, 'file')} here, and every file stays in the chat and is re-read on each reply.`]
  if (repeat[0]) lines.push(`${baseName(repeat[0].path)} was read ${repeat[0].reads} times. Pointing Claude to the part you need avoids that.`)
  return { lines, fixes: [], rows: c.files.map(f => ({ name: baseName(f.path), value: `~${fmtTokens(f.tokens)}`, note: plural(f.reads, 'read') })) }
}

export function explainTools(s: Snapshot): Why {
  const c = s.scan?.chat
  if (!c) return { lines: ['No log for this chat yet.'], fixes: [], rows: [] }
  const rows = [...c.tools, ...c.connectors.filter(x => !x.name.startsWith('ccd_')).map(x => ({ ...x, name: `Used ${appName(x.name)}` }))].sort((x, y) => y.tokens - x.tokens)
  const top = rows[0]
  const lines = [`What Claude's jobs brought back takes about ${fmtTokens(c.toolResultTokens)} tokens, and it stays in the chat after the job ends.`]
  if (top) lines.push(`${workOf(top.name)} added the most.`)
  return { lines, fixes: [], rows: rows.map(t => ({ name: workOf(t.name), value: `~${fmtTokens(t.tokens)}`, note: plural(t.calls, 'time') })) }
}

export function explainWindow(w: WindowScan, chat: ChatRow): string[] {
  const avg = chat.replies ? Math.round((chat.cacheRead + chat.input) / chat.replies) : 0
  const lines = [`About ${chat.share}% of the usage tracked in this window. ${replyWord(chat.replies)}, re-reading about ${fmtTokens(avg)} tokens each.`]
  const parts = [
    { n: 're-reading the chat from cache', v: chat.cacheRead * 0.05 },
    { n: 'saving new content to the cache', v: chat.cacheWrite * 2 },
    { n: "Claude's replies", v: chat.output * 5 },
    { n: 'uncached input', v: chat.input },
  ].sort((x, y) => y.v - x.v)
  if (parts[0]) lines.push(`Its biggest cost is ${parts[0].n}.`)
  if (w.chatCount > 15) lines.push(`Showing the top 15 of ${w.chatCount} chats.`)
  return lines
}

// ---------- Actions

async function say($: EngineInterface, text: string) {
  await update($, panel, p => ({ ...p, notice: text, confirm: '' }))
}

// The Code tab has no direct compact call: compaction there runs as a /compact prompt.
// Ask for the command first, then leave it in the prompt box, and say plainly which happened.
async function runCompact($: EngineInterface) {
  try {
    await $.command.run({ command: 'compact' })
    await say($, 'Compact ran. The chat below shows the result.')
    await refreshQuietly($, true)
    return
  } catch {
    // Not available on this surface. The prompt box is the next way.
  }
  await say($, (await fillPrompt($, '/compact')) ? '/compact is in your prompt box. Press Return to run it. This uses some tokens once.' : 'The panel could not reach the prompt box. Type /compact there to compact this chat.')
}

async function fillPrompt($: EngineInterface, text: string): Promise<boolean> {
  try {
    return (await $.prompt.fill({ text })).isFilled
  } catch {
    return false
  }
}

async function runFix($: EngineInterface, fix: Fix) {
  if (fix.act === 'compact') {
    const p = await read($, panel)
    if (p.confirm !== 'compact') {
      await update($, panel, x => ({ ...x, confirm: 'compact', notice: '' }))
      return
    }
    await runCompact($)
  } else if (fix.act === 'handoff') {
    await say($, (await fillPrompt($, HANDOFF_PROMPT)) ? 'A handoff request is in your prompt box. Nothing has been sent.' : 'The panel could not reach the prompt box, so nothing was added.')
  } else if (fix.act === 'warm') {
    await toggleWarm($)
  }
}

async function stopWarm($: EngineInterface, note: string) {
  await update($, warm, w => (w.isOn ? { ...w, isOn: false, isSending: false, note } : w))
}

async function toggleWarm($: EngineInterface) {
  const w = await read($, warm)
  if (w.isOn) return stopWarm($, 'Keep warm is off.')
  const c = await read($, cache)
  if (!c.lastEnd) return update($, warm, x => ({ ...x, note: 'Nothing to keep warm until Claude has replied.' }))
  const at = await $.clock.now()
  await update($, warm, () => ({ isOn: true, startedAt: at, pings: 0, isSending: false, failures: 0, note: '' }))
}

async function warmTick($: EngineInterface, at: number) {
  const w = await read($, warm)
  if (!w.isOn || isPinging) return
  const l = await read($, live)
  if (l.isWorking) return
  if (at - w.startedAt >= WARM_MAX_MS) return stopWarm($, 'Keep warm stopped after 2 hours.')
  if (w.pings >= WARM_MAX_PINGS) return stopWarm($, `Keep warm stopped after ${WARM_MAX_PINGS} pings.`)
  const c = await read($, cache)
  if (at < c.lastEnd + c.ttlMs - WARM_LEAD) return
  isPinging = true
  await update($, warm, x => ({ ...x, isSending: true }))
  try {
    const r = await $.model.fork({ prompt: WARM_PROMPT })
    const ok = r.isAnswered || r.reason === 'empty-reply'
    const after = await $.clock.now()
    if (ok) {
      await update($, cache, x => ({ ...x, lastEnd: after }))
      await update($, warm, x => ({ ...x, pings: x.pings + 1, isSending: false, failures: 0 }))
    } else {
      const fails = w.failures + 1
      await update($, warm, x => ({ ...x, isSending: false, failures: fails }))
      if (fails >= 3) await stopWarm($, 'Keep warm stopped: three pings in a row failed.')
    }
  } catch {
    await stopWarm($, 'Keep warm stopped: a ping failed.')
  } finally {
    isPinging = false
  }
}

// ---------- Drawing helpers (the look follows savvy-progress)

const barWidth = (e: { props: { bodyColumns?: number } }) => Math.max(220, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + (/[iljtf.,:;·' ]/.test(ch) ? 0.3 : /[A-Z%mw]/.test(ch) ? 0.72 : 0.54) * size, 0)
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) break
    out += ch
  }
  return `${out}…`
}
const svg = (W: number, H: number, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${xml(FONT)}">${PANE_CSS}${MASCOT_CSS}${body}</svg>`
const txt = (cls: string, x: number, y: number, size: number, words: string, extra = '') => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" ${extra}>${xml(words)}</text>`
const num = 'font-variant-numeric="tabular-nums"'

const thinBar = (id: string, x: number, y: number, w: number, h: number, segments: { color: string; share: number }[]): string => {
  let at = x
  const rects = segments
    .map(s => {
      const width = Math.max(0, Math.min(x + w - at, (s.share / 100) * w))
      const r = `<rect x="${at.toFixed(1)}" y="${y}" width="${width.toFixed(1)}" height="${h}" fill="${s.color}"/>`
      at += width
      return r
    })
    .join('')
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/></clipPath></defs><g clip-path="url(#${id})"><rect class="k" x="${x}" y="${y}" width="${w}" height="${h}"/>${rects}</g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${GOOD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${BAD}" stroke-width="1.8" stroke-linecap="round"/>`
  return ''
}

type AgentCard = { look: string; isWalking: boolean; title: string; tag: string; tagColor: string; meta: string; stats: string; left: string; ratio: number; barColor: string; status: string }
const AGENT_H = 66
export const agentSvg = (W: number, a: AgentCard): string => {
  const textW = W - 42 - 22
  const tagText = fitText(a.tag, 11, textW)
  const metaX = 42 + textWidth(tagText, 11) + 8
  return svg(
    W,
    AGENT_H,
    `${mascot(0, 14, a.look, false, a.isWalking, 1.1)}
${txt('t', 42, 18, 13, fitText(a.title, 13, textW), 'font-weight="600"')}
<text x="42" y="34" font-size="11" fill="${a.tagColor}">${xml(tagText)}</text>${a.meta ? txt('s', metaX, 34, 11, fitText(a.meta, 11, W - metaX - 8)) : ''}
${a.left ? txt('t', 42, 49, 11, fitText(a.left, 11, Math.max(0, textW - textWidth(a.stats, 11) - 8)), num) : ''}
${txt('s', 42 + textW, 49, 11, a.stats, `text-anchor="end" ${num}`)}
${thinBar(`a${Math.abs(hash(a.title))}`, 42, 55, textW, 4, [{ color: a.barColor, share: a.ratio * 100 }])}
${statusMark(W - 8, 16, a.status, a.barColor)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 99991, 7)

const USAGE_H = 54
export const usageSvg = (W: number, u: { id: string; title: string; value: string; meta: string; right: string; isOpen: boolean; segments: { color: string; share: number }[] }): string => {
  const valueW = textWidth(u.value, 13) + 4
  return svg(
    W,
    USAGE_H,
    `${txt('m', 0, 17, 10, u.isOpen ? '▾' : '▸')}
${txt('t', 14, 18, 13, fitText(u.title, 13, W - valueW - 24), 'font-weight="600"')}
${txt('t', W, 18, 13, u.value, `text-anchor="end" font-weight="600" ${num}`)}
${txt('s', 14, 34, 11, fitText(u.meta, 11, W - 14 - textWidth(u.right, 11) - 8), num)}
${txt('s', W, 34, 11, u.right, `text-anchor="end" ${num}`)}
${thinBar(`u${u.id}`, 0, 42, W, 5, u.segments)}`,
  )
}

const MASCOT_W = 92
const HERO_HEAD_H = 34
const HERO_BAR_H = 36
export const heroMascotSvg = (look: string, isWalking: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MASCOT_W}" height="88" viewBox="0 0 ${MASCOT_W} 88">${MASCOT_CSS}${mascot(1, 2, look, false, isWalking, 3)}</svg>`
export const heroHeadSvg = (W: number, name: string, model: string, isWorking: boolean): string =>
  svg(W, HERO_HEAD_H, `${txt('t', 0, 14, 14, fitText(name, 14, W - 16), 'font-weight="600"')}<text x="0" y="29" font-size="11" fill="#D97757">${xml(model)}</text>${txt('s', textWidth(model, 11) + 8, 29, 11, isWorking ? 'Working' : 'Idle')}${isWorking ? statusMark(W - 6, 10, 'running', '#D97757') : ''}`)
export const heroBarSvg = (W: number, b: { id: string; title: string; note: string; value: string; isOpen: boolean; segments: { color: string; share: number }[] }): string => {
  const valueW = textWidth(b.value, 12) + 4
  const titleW = textWidth(b.title, 12) + 13
  return svg(
    W,
    HERO_BAR_H,
    `${txt('m', 0, 14, 8, b.isOpen ? '▾' : '▸')}${txt('t', 10, 15, 12, b.title, 'font-weight="600"')}${txt('s', 10 + titleW - 8, 15, 10, fitText(b.note, 10, Math.max(0, W - titleW - valueW - 6)), num)}${txt('t', W, 15, 12, b.value, `text-anchor="end" font-weight="600" ${num}`)}
${thinBar(`h${b.id}`, 0, 22, W, 6, b.segments)}`,
  )
}

const TILE_H = 44
export const tilesSvg = (W: number, tiles: { k: string; v: string }[]): string => {
  const gap = 6
  const tw = (W - gap * (tiles.length - 1)) / tiles.length
  return svg(
    W,
    TILE_H,
    tiles
      .map((t, i) => {
        const x = i * (tw + gap)
        return `<rect class="tile" x="${x}" y="0" width="${tw}" height="40" rx="8"/>${txt('s', x + 9, 16, 11, t.k)}${txt('t', x + 9, 33, 15, fitText(t.v, 15, tw - 14), `font-weight="600" ${num}`)}`
      })
      .join(''),
  )
}

const LINE_H = 26
export const legendSvg = (W: number, color: string, name: string, value: string, share: string): string =>
  svg(W, LINE_H, `<rect x="0" y="7" width="11" height="11" rx="2.5" fill="${color}"/>${txt('t', 19, 17, 12, fitText(name, 12, W - 112))}${txt('s', W - 46, 17, 12, value, `text-anchor="end" ${num}`)}${txt('s', W, 17, 12, share, `text-anchor="end" ${num}`)}`)

const JOB_H = 28
export const jobSvg = (W: number, color: string, name: string, value: string, isOpen: boolean): string =>
  svg(W, JOB_H, `<rect x="0" y="9" width="9" height="9" rx="2" fill="${color}"/>${txt('t', 16, 18, 12, fitText(name, 12, W - 16 - 66))}${txt('s', W - 11, 18, 12, value, `text-anchor="end" ${num}`)}${txt('m', W, 17, 8, isOpen ? '▾' : '▸', 'text-anchor="end"')}<line class="ln" x1="0" y1="27.5" x2="${W}" y2="27.5"/>`)

const CHAT_H = 50
export const chatSvg = (W: number, c: ChatRow, color: string, at: number): string =>
  svg(
    W,
    CHAT_H,
    `${txt('t', 0, 16, 13, fitText(c.title, 13, W - 56), 'font-weight="600"')}${txt('t', W, 16, 13, `${c.share}%`, `text-anchor="end" font-weight="600" ${num}`)}
${txt('s', 0, 32, 11, fitText(`${c.project} · ${replyWord(c.replies)} · ${agoWords(at - c.lastAt)}`, 11, W))}
${thinBar(`c${Math.abs(hash(c.id))}`, 0, 39, W, 4, [{ color, share: c.share }])}
<line class="ln" x1="0" y1="49.5" x2="${W}" y2="49.5"/>`,
  )

const LOOK_H = 44
export const lookSvg = (W: number, look: string, name: string, isCurrent: boolean): string =>
  svg(W, LOOK_H, `${mascot(0, 6, look, false, true, 1.1)}${txt('t', 42, 26, 13, name, isCurrent ? 'font-weight="600"' : '')}${isCurrent ? statusMark(W - 8, 22, 'done', GOOD) : ''}<line class="ln" x1="0" y1="43.5" x2="${W}" y2="43.5"/>`)

export const gridSvg = (W: number, grid: Breakdown['grid']): { source: string; height: number } => {
  const cols = grid[0]?.length ?? 1
  const gap = 3
  const cell = Math.min(16, Math.floor((W - gap * (cols - 1)) / cols))
  const height = grid.length * (cell + gap)
  const body = grid
    .flatMap((row, y) =>
      row.map((s, x) => {
        const color = categoryColor(s.name)
        const px = x * (cell + gap)
        const py = y * (cell + gap)
        if (!s.isFilled || /free/i.test(s.name)) return `<rect class="k" x="${px}" y="${py}" width="${cell}" height="${cell}" rx="2"/>`
        return s.fullness < 0.7
          ? `<rect x="${px + 0.5}" y="${py + 0.5}" width="${cell - 1}" height="${cell - 1}" rx="2" fill="none" stroke="${color}"/>`
          : `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="2" fill="${color}"/>`
      }),
    )
    .join('')
  return { source: svg(W, height, body), height }
}

const tokenSegments = (t: { input: number; output: number; cacheWrite: number; cacheRead: number }) => {
  const total = t.input + t.output + t.cacheWrite + t.cacheRead || 1
  return [
    { label: 'Claude replies', tokens: t.output, color: '#D97757' },
    { label: 'New context', tokens: t.input + t.cacheWrite, color: '#378ADD' },
    { label: 'Re-read from cache', tokens: t.cacheRead, color: '#888780' },
  ].map(s => ({ ...s, share: (s.tokens / total) * 100 }))
}

const lookOf = (a: AgentRun) => (a.type === 'Explore' ? 'explore' : /fable|mythos/.test(a.model) ? 'fable' : /opus/.test(a.model) ? 'heavy' : /sonnet/.test(a.model) ? 'medium' : /haiku/.test(a.model) ? 'light' : 'other')
const TIER: Record<string, string> = { fable: '#7F77DD', heavy: '#D85A30', medium: '#378ADD', light: '#1D9E75', explore: '#1D9E75', other: '#888780' }

// ---------- The module

// The version comes from the installed plugin's own manifest, so it can't drift from what runs.
async function titleOf($: EngineInterface): Promise<string> {
  try {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    const version = (JSON.parse(text) as { version?: unknown }).version
    return typeof version === 'string' && version ? `${TITLE} ${version}` : TITLE
  } catch {
    return TITLE
  }
}

// A chat with no window yet has nowhere to draw: open when one attaches.
async function tryOpen($: EngineInterface) {
  try {
    const { isPlaced } = await $.ui.open({ id: PANE, title: await titleOf($) })
    isOpenPending = !isPlaced
  } catch {
    isOpenPending = true
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sid = await $.session.id()
    const saved = await $.store.get('costume')
    if (typeof saved === 'string') await update($, costume, () => saved)
    const savedName = await $.store.get('agentName')
    if (typeof savedName === 'string' && savedName) await update($, agentName, () => savedName)
    // After a restart nothing is mid-job, whatever was saved. A job that really is running marks itself again.
    await update($, live, l => ({ ...l, isWorking: false, recent: l.recent.map(r => ({ ...r, isDone: true })) }))
    await update($, agents, list => list.map((a): AgentRun => (a.status === 'running' ? { ...a, status: 'failed', endedAt: a.startedAt, current: '' } : a)))
    await $.command.register({ name: 'usage-desk', description: 'Open the Usage Desk panel' })
    await tryOpen($)
    void refreshQuietly($, true)

    // Seconds for the clock and keep warm; a light read while working; a deep one each minute.
    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const at = await $.clock.now()
        const c = await read($, cache)
        const l = await read($, live)
        const isCounting = c.lastEnd > 0 && at < c.lastEnd + c.ttlMs
        const shown = await read($, now)
        const justExpired = c.lastEnd > 0 && shown < c.lastEnd + c.ttlMs
        if (isCounting || justExpired || l.isWorking || ticks % 30 === 0) await update($, now, () => at)
        await warmTick($, at)
        if (l.isWorking && ticks % 5 === 0) await refreshQuietly($, false)
        if (l.isWorking && ticks % 10 === 0) await rescan($)
        if (ticks % 60 === 0) await refreshQuietly($, !l.isWorking)
      })().catch(() => undefined)
    })
    return started
  })

  on('session.attach', async ($, e, next) => {
    const out = await next(e)
    if (isOpenPending) await tryOpen($)
    return out
  })

  on('command.run', { command: 'usage-desk' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: await titleOf($) })
    await refreshQuietly($, true)
    return { text: isPlaced ? 'Usage Desk is open.' : 'Usage Desk could not open here.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.text === WARM_PROMPT || isPinging
    if (!isOwn) {
      await quiet(update($, live, l => ({ ...l, isWorking: true })))
      // A background notice is not the person coming back.
      if (!BACKGROUND.has(e.origin?.kind ?? '')) void stopWarm($, 'Keep warm stopped: you sent a message.').catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // What the agent touches, as it happens.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    const fields = e as unknown as Record<string, unknown>
    // A command is shown by Claude's own description of it, never as raw shell text.
    const label = tool === 'Bash' ? (typeof fields.description === 'string' ? fields.description : '') : labelOf(fields)
    if (isHousekeeping(tool)) return next(e)
    const row: Activity = { id: e.tool_use_id, tool, label, agent: e.agentId ?? '', isDone: false, isFailed: false, at: Date.now() }
    const connector = connectorOf(tool)
    await quiet(update($, live, l => ({
      ...l,
      isWorking: true,
      recent: [...l.recent, row].slice(-30),
      counts: { ...l.counts, [tool]: (l.counts[tool] ?? 0) + 1 },
      files: (tool === 'Read' || tool === 'Edit' || tool === 'Write') && label && !l.files.includes(label) ? [...l.files, label].slice(-50) : l.files,
      skills: tool === 'Skill' && label && !l.skills.includes(label) ? [...l.skills, label] : l.skills,
      connectors: connector ? { ...l.connectors, [connector]: (l.connectors[connector] ?? 0) + 1 } : l.connectors,
    })))
    if (e.agentId) await quiet(update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, current: `${friendlyTool(tool)}${label ? ` · ${label}` : ''}` } : a))))
    let failed = true
    try {
      const out = await next(e)
      failed = false
      return out
    } finally {
      await quiet(update($, live, l => ({ ...l, recent: l.recent.map(r => (r.id === row.id ? { ...r, isDone: true, isFailed: failed } : r)) })))
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const at = Date.now()
    const run: AgentRun = { id: started.agentId ?? e.tool_use_id, agentId: started.agentId ?? '', type: e.subagentType, description: e.description, model: started.model ?? '', status: 'running', startedAt: at, endedAt: 0, contextTokens: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, steps: 0, current: '' }
    await quiet(update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-40)))
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    const agentId = e.agentId
    if (agentId && usage) {
      const i = usage.input_tokens || 0
      const o = usage.output_tokens || 0
      const w = usage.cache_creation_input_tokens || 0
      const r = usage.cache_read_input_tokens || 0
      await update($, agents, list =>
        list.map((a): AgentRun => (a.agentId !== agentId ? a : { ...a, model: usage.model || a.model, status: 'running', contextTokens: i + o + w + r, tokens: a.tokens + i + o + w + r, input: a.input + i, output: a.output + o, cacheWrite: a.cacheWrite + w, cacheRead: a.cacheRead + r, steps: a.steps + 1 })),
      )
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    if (e.agentId) {
      const agentId = e.agentId
      await update($, agents, list => list.map((a): AgentRun => (a.agentId === agentId ? { ...a, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at, current: '' } : a)))
      return result
    }
    await update($, live, l => ({ ...l, isWorking: false }))
    void (async () => {
      await refresh($, true)
      const s = await read($, snapshot)
      const ttl = s.scan?.chat.ttl
      await update($, cache, c => ({ lastEnd: at, ttlMs: ttl === '1h' ? ONE_H : ttl === '5m' ? FIVE_M : c.ttlMs, isKnown: ttl === '1h' || ttl === '5m', tokens: s.chatTokens }))
    })().catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const s = await read($, snapshot)
    const p = await read($, panel)
    const l = await read($, live)
    const list = await read($, agents)
    const c = await read($, cache)
    const w = await read($, warm)
    const at = await read($, now)
    const look = await read($, costume)
    const name = await read($, agentName)
    const W = barWidth(e)

    const set = (patch: Partial<Panel>) => update($, panel, x => ({ ...x, ...patch, confirm: '', notice: '' }))
    const toggle = (open: string) => {
      const isClosing = p.open === open
      void set(isClosing ? { open: '', detail: '', chat: '' } : { open, detail: '', chat: '' })
      if (!isClosing) void refreshQuietly($, true, open === 'chat')
    }

    // A drawing cannot take a press, so a row of blank Buttons lies over it. Every line
    // of the row's height is one Button: all of them press the same thing.
    const pressable = (key: string, height: number, source: string, alt: string, onPress: () => void, width = W) => {
      if (!Svg) return <Button key={key} plain label={alt} onPress={onPress} />
      const blank = ' '.repeat(Math.max(4, Math.floor(width / 4.2)))
      const lines = Math.max(1, Math.ceil(height / 22))
      return (
        <Box key={key} position="relative" flexDirection="column" width="100%" overflow="hidden">
          <Svg key={`${key}-d`} source={source} alt={alt} width={width} height={height} />
          <Box key={`${key}-o`} position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" overflow="hidden">
            {Array.from({ length: lines }, (_, i) => <Button key={`${key}-p${i}`} plain label={blank} onPress={onPress} />)}
          </Box>
        </Box>
      )
    }

    const row = (key: string, name: string, value: string, note?: string, color?: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          {color && <Text color={color}>■</Text>}
          <Text wrap="truncate-end">{name}</Text>
          {note && <Text dimColor wrap="truncate-end">{note}</Text>}
        </Box>
        <Text tabular dimColor>{value}</Text>
      </Box>
    )

    const head = (key: string, words: string) => <Text key={key} dimColor>{words}</Text>
    const back = (key: string, onPress: () => void) => <Button key={key} plain label="‹ Back" onPress={onPress} />

    const why = (key: string, title: string, y: Why) => (
      <Box key={key} flexDirection="column" rowGap={1}>
        {back(`${key}-back`, () => void set({ detail: '' }))}
        <Text weight="semibold">{title}</Text>
        {y.lines.map((line, i) => <Text key={`${key}-l${i}`}>{line}</Text>)}
        {y.rows.length > 0 && <Box flexDirection="column">{y.rows.map((r, i) => row(`${key}-r${i}`, r.name, r.value, r.note))}</Box>}
        {y.fixes.length > 0 && (
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {y.fixes.map(f => <Button key={`${key}-${f.key}`} variant={f.act === 'compact' && p.confirm === 'compact' ? 'primary' : undefined} label={f.act === 'compact' && p.confirm === 'compact' ? 'Confirm: compact this chat' : f.label} onPress={() => void runFix($, f)} />)}
          </Box>
        )}
      </Box>
    )

    // The chat section: the /context view, each row opening its explanation.
    const chatSection = () => {
      const b = s.breakdown
      if (!b) return <Text key="chat-empty" dimColor>The breakdown appears after Claude's first reply.</Text>
      if (p.detail === 'files') return why('files', 'Files read', explainFiles(s))
      if (p.detail === 'tools') return why('tools', 'Results of jobs', explainTools(s))
      const picked = b.categories.find(x => x.name === p.detail)
      if (picked) return why('cat', picked.name, explain(picked.name, picked.tokens, s))
      const g = gridSvg(W, b.grid)
      const sc = s.scan?.chat
      const pct = (n: number) => (s.chatWindow ? `${((n / s.chatWindow) * 100).toFixed(1)}%` : '')
      return (
        <Box key="chat-open" flexDirection="column" rowGap={1}>
          {Svg && b.grid.length > 0 && <Svg key="grid" source={g.source} alt={`${s.chatPercent}% of this chat's space is used`} width={W} height={g.height} />}
          <Box flexDirection="column">
            {[...b.categories].sort(categoryOrder).map((x: Category) =>
              pressable(`cat-${x.name}`, LINE_H, legendSvg(W, categoryColor(x.name), x.name, fmtTokens(x.tokens), pct(x.tokens)), `${x.name} ${fmtTokens(x.tokens)}`, () => void set({ detail: x.name })),
            )}
            {sc && sc.files.length > 0 && pressable('d-files', LINE_H, legendSvg(W, '#888780', 'Files read', String(sc.files.length), ''), `Files read ${sc.files.length}`, () => void set({ detail: 'files' }))}
            {sc && sc.toolResultTokens > 0 && pressable('d-tools', LINE_H, legendSvg(W, '#888780', 'Results of jobs', `~${fmtTokens(sc.toolResultTokens)}`, ''), `Results of jobs ${fmtTokens(sc.toolResultTokens)}`, () => void set({ detail: 'tools' }))}
          </Box>
          {sc && <Text dimColor>Whole chat so far: {fmtTokens(sc.output)} written by Claude, {fmtTokens(sc.input + sc.cacheWrite)} new context, {fmtTokens(sc.cacheRead)} re-read from cache.</Text>}
        </Box>
      )
    }

    // The 5-hour and weekly sections: which chats and projects the tracked usage came from.
    const windowSection = (key: string, name: string, limit: Limit | null, data: WindowScan | undefined, color: string) => {
      if (!data) return <Text key={`${key}-empty`} dimColor>Reading your chat logs…</Text>
      const picked = data.chats.find(x => x.id === p.chat)
      if (picked) {
        return (
          <Box key={`${key}-chat`} flexDirection="column" rowGap={1}>
            {back(`${key}-back`, () => void set({ chat: '' }))}
            <Text weight="semibold">{picked.title}</Text>
            <Text dimColor>{picked.project} · last active {agoWords(at - picked.lastAt)}</Text>
            {explainWindow(data, picked).map((t, i) => <Text key={`${key}-w${i}`}>{t}</Text>)}
            <Box flexDirection="column">
              {tokenSegments(picked).map(x => row(`${key}-s-${x.label}`, x.label, fmtTokens(x.tokens), undefined, x.color))}
            </Box>
          </Box>
        )
      }
      const segs = tokenSegments(data)
      return (
        <Box key={`${key}-open`} flexDirection="column" rowGap={1}>
          <Text>{limit ? `${limit.percent}% of your ${name} limit is used, as reported by Claude.` : `No ${name} reading yet.`}</Text>
          <Text dimColor>The tokens and chats below are from the Code tab only. Cowork and claude.ai also count towards this limit, but their chats cannot be seen from here.</Text>
          <Box flexDirection="column">{segs.map(x => row(`${key}-m-${x.label}`, x.label, fmtTokens(x.tokens), undefined, x.color))}</Box>
          {data.chats.length === 0 && <Text dimColor>No Code tab chats in this window.</Text>}
          {data.chats.length > 0 && head(`${key}-h`, `Chats · ${data.chatCount} · estimated share of tracked usage`)}
          <Box flexDirection="column">
            {data.chats.map(x => pressable(`${key}-c-${x.id}`, CHAT_H, chatSvg(W, x, color, at), `${x.title} ${x.share}%`, () => void set({ chat: x.id })))}
          </Box>
          {data.projects.length > 1 && head(`${key}-ph`, `Projects · ${data.projects.length}`)}
          {data.projects.length > 1 && <Box flexDirection="column">{data.projects.map(x => row(`${key}-p-${x.name}`, x.name, `${x.share}%`, plural(x.chats, 'chat')))}</Box>}
        </Box>
      )
    }

    const agentCard = (a: AgentRun): AgentCard => {
      const lookName = lookOf(a)
      const end = a.status === 'running' ? at : a.endedAt
      return {
        look: lookName,
        isWalking: a.status === 'running',
        title: a.description || a.type,
        tag: a.type,
        tagColor: TIER[lookName] ?? '#888780',
        meta: modelName(a.model),
        left: a.current && a.status === 'running' ? shortLabel(a.current) : plural(a.steps, 'step'),
        stats: `${fmtTokens(a.tokens)}  ≈${fmtCost(costOf(a.model, a))}  ${clockTime(Math.max(0, end - a.startedAt))}`,
        ratio: Math.min(1, a.contextTokens / (s.chatWindow || 200000)),
        barColor: TIER[lookName] ?? '#888780',
        status: a.status,
      }
    }

    const agentSection = (a: AgentRun) => (
      <Box key={`a-open-${a.id}`} flexDirection="column">
        {a.current && <Text dimColor wrap="wrap">Now: {a.current}</Text>}
        {tokenSegments(a).map(x => row(`a-${a.id}-${x.label}`, x.label, fmtTokens(x.tokens), undefined, x.color))}
      </Box>
    )

    const chatSegments = s.breakdown ? [...s.breakdown.categories].filter(x => x.kind === 'used').sort(categoryOrder).map(x => ({ color: categoryColor(x.name), share: s.chatWindow ? (x.tokens / s.chatWindow) * 100 : 0 })) : [{ color: '#D97757', share: s.chatPercent }]

    const limitLine = (limit: Limit | null) => {
      if (!limit) return 'no reading yet'
      if (!limit.isLive) return `saved ${agoWords(at - limit.readAt)}`
      return resetWords(limit.resetsAt, at)
    }
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').slice(-5).reverse()
    const cacheLeft = c.lastEnd ? c.lastEnd + c.ttlMs - at : 0
    const cachePct = c.ttlMs ? Math.max(0, Math.min(100, (cacheLeft / c.ttlMs) * 100)) : 0
    const cacheColor = cachePct > 40 ? GOOD : cachePct > 15 ? '#D9A441' : BAD
    const busy = l.recent.filter(r => !isHousekeeping(r.tool) && !r.isDone).slice(-4).reverse()
    const timeline = (sc0 => (sc0?.timeline ?? []).filter(r => r.kind === 'reply' || !isHousekeeping(r.tool)).reverse())(s.scan?.chat)
    const rows = timeline.slice(0, p.moreJobs ? 40 : 10)
    const summary = jobSummary(l.counts)
    const apps = Object.entries(l.connectors).filter(([k]) => !k.startsWith('ccd_')).map(([k, n]) => `${appName(k)} (${n})`)
    const sc = s.scan?.chat
    const whole = sc ? sc.input + sc.output + sc.cacheWrite + sc.cacheRead + sc.subagentTokens : 0
    const lookName = COSTUMES.find(x => x.value === look)?.label ?? 'Owl'

    const openLooks = () => void update($, panel, x => ({ ...x, showLooks: !x.showLooks }))
    const R = Math.max(120, W - MASCOT_W - 14)
    const startRename = () => void update($, panel, x => ({ ...x, isRenaming: !x.isRenaming }))
    const saveName = (value: string) => {
      const clean = cleanName(value)
      void update($, agentName, () => clean)
      void $.store.set('agentName', clean)
      void update($, panel, x => ({ ...x, isRenaming: false }))
    }
    // A big chat is worth flagging before anyone opens a menu.
    const reread = sc && sc.replies ? s.chatTokens : 0

    return (
      <Box flexDirection="column" rowGap={1}>
        {Svg ? (
          <Box key="hero" flexDirection="row" columnGap={1} alignItems="center">
            <Box key="hero-mascot" width={`${Math.round(((MASCOT_W + 2) / W) * 100)}%`} flexShrink={0}>
              {pressable('me', 88, heroMascotSvg(look, l.isWorking), `Your agent, ${lookName}. Press to change the icon.`, openLooks, MASCOT_W)}
            </Box>
            <Box key="hero-right" flexDirection="column" flexGrow={1} flexShrink={1}>
              {pressable('hero-name', HERO_HEAD_H, heroHeadSvg(R, name, modelName(s.model), l.isWorking), `${name}, ${l.isWorking ? 'working' : 'idle'}. Press to rename.`, startRename, R)}
              {pressable('b-chat', HERO_BAR_H, heroBarSvg(R, { id: 'chat', title: 'Current chat', note: `${fmtTokens(s.chatTokens)}/${fmtTokens(s.chatWindow)}`, value: `${Math.round(s.chatPercent)}%`, isOpen: p.open === 'chat', segments: chatSegments }), `Current chat ${Math.round(s.chatPercent)}%`, () => toggle('chat'), R)}
              {pressable('b-five', HERO_BAR_H, heroBarSvg(R, { id: 'five', title: '5 hours', note: limitLine(s.five), value: s.five ? `${s.five.percent}%` : '–', isOpen: p.open === 'five', segments: [{ color: FIVE_COLOR, share: s.five?.percent ?? 0 }] }), `5 hours ${s.five?.percent ?? 0}%`, () => toggle('five'), R)}
              {pressable('b-week', HERO_BAR_H, heroBarSvg(R, { id: 'week', title: 'Weekly', note: limitLine(s.week), value: s.week ? `${s.week.percent}%` : '–', isOpen: p.open === 'week', segments: [{ color: WEEK_COLOR, share: s.week?.percent ?? 0 }] }), `Weekly ${s.week?.percent ?? 0}%`, () => toggle('week'), R)}
            </Box>
          </Box>
        ) : (
          <Box key="hero-text" flexDirection="column">
            {pressable('me', 0, '', `${name} · ${l.isWorking ? 'Working' : 'Idle'}`, startRename)}
            {pressable('looks-t', 0, '', 'Change icon', openLooks)}
            {pressable('b-chat', 0, '', `Current chat ${Math.round(s.chatPercent)}%`, () => toggle('chat'))}
            {pressable('b-five', 0, '', `5 hours ${s.five?.percent ?? 0}%`, () => toggle('five'))}
            {pressable('b-week', 0, '', `Weekly ${s.week?.percent ?? 0}%`, () => toggle('week'))}
          </Box>
        )}

        {p.isRenaming && 'Input' in ui && (
          <Box key="rename" flexDirection="column" rowGap={1}>
            <ui.Input key="rename-input" label="Agent name" placeholder={DEFAULT_NAME} value={name === DEFAULT_NAME ? '' : name} submitLabel="Save" autoFocus onSubmit={value => saveName(value)} />
            <Button key="rename-cancel" plain label="Cancel" onPress={() => void update($, panel, x => ({ ...x, isRenaming: false }))} />
          </Box>
        )}

        {Svg && <Svg key="tiles" source={tilesSvg(W, [{ k: 'Est. cost', v: `≈${fmtCost(sc ? sc.cost + sc.subagentCost : s.cost)}` }, { k: 'Tokens used', v: fmtTokens(whole) }, { k: 'Chat age', v: s.startedAt ? clockTime(Math.max(0, at - s.startedAt)) : '–' }])} alt="Estimated cost, tokens used and age of this chat" width={W} height={TILE_H} />}

        {p.showLooks && (
          <Box key="looks" flexDirection="column">
            {head('looks-h', `Agent icon · ${lookName}`)}
            {COSTUMES.map(x =>
              pressable(`look-${x.value}`, LOOK_H, Svg ? lookSvg(W, x.value, x.label, x.value === look) : '', x.label, () => {
                void update($, costume, () => x.value)
                void $.store.set('costume', x.value)
                void update($, panel, y => ({ ...y, showLooks: false }))
              }),
            )}
          </Box>
        )}

        {isBigChat(s) && reread > 0 && p.detail === '' && p.open !== 'chat' && (
          <Box key="big" flexDirection="column">
            <Text dimColor>This chat is big: every reply re-reads about {fmtTokens(reread)} tokens.</Text>
            <Button key="big-open" plain label="See how to reduce it ›" onPress={() => { void set({ open: 'chat', detail: 'Messages', chat: '' }); void refreshQuietly($, true, true) }} />
          </Box>
        )}

        {p.open === 'chat' && chatSection()}
        {p.open === 'five' && windowSection('five', '5-hour', s.five, s.scan?.five, FIVE_COLOR)}
        {p.open === 'week' && windowSection('week', 'weekly', s.week, s.scan?.week, WEEK_COLOR)}

        {p.notice !== '' && <Text dimColor>{p.notice}</Text>}

        {running.length > 0 && head('h-run', `Running · ${running.length}`)}
        {running.map(a => (
          <Box key={`a-${a.id}`} flexDirection="column">
            {pressable(`a-r-${a.id}`, AGENT_H, Svg ? agentSvg(W, agentCard(a)) : '', `${a.description}, running`, () => toggle(`agent:${a.id}`))}
            {p.open === `agent:${a.id}` && agentSection(a)}
          </Box>
        ))}
        {finished.length > 0 && head('h-done', `Finished · ${finished.length}`)}
        {finished.map(a => (
          <Box key={`a-${a.id}`} flexDirection="column">
            {pressable(`a-r-${a.id}`, AGENT_H, Svg ? agentSvg(W, agentCard(a)) : '', `${a.description}, ${a.status}`, () => toggle(`agent:${a.id}`))}
            {p.open === `agent:${a.id}` && agentSection(a)}
          </Box>
        ))}

        <Box key="s-cache" flexDirection="column">
          {head('h-cache', 'Cache')}
          {Svg && <Svg key="d-cache" source={usageSvg(W, { id: 'cache', title: !c.lastEnd ? 'Waiting for a reply' : cacheLeft > 0 ? 'Warm' : 'Cold', value: cacheLeft > 0 ? mmss(cacheLeft) : '0:00', meta: c.isKnown ? `${c.ttlMs === ONE_H ? '1 hour' : '5 minute'} cache` : 'cache length not known yet', right: cacheLeft > 0 ? '' : 'next reply re-writes it', isOpen: false, segments: [{ color: cacheColor, share: cachePct }] }).replace('>▸<', '><')} alt={`Cache ${mmss(cacheLeft)} left`} width={W} height={USAGE_H} />}
          <Button key="warm" plain label={w.isOn ? (w.isSending ? 'Pinging…' : 'Stop keep warm') : 'Keep warm'} onPress={() => void toggleWarm($)} />
          {w.isOn && <Text dimColor>{plural(w.pings, 'ping')} sent. Each one uses a little of your limit.</Text>}
          {!w.isOn && w.note !== '' && <Text dimColor>{w.note}</Text>}
        </Box>

        <Box key="s-live" flexDirection="column">
          <Button key="live-t" plain label={`${p.showActivity ? '▾' : '▸'} What Claude did`} onPress={() => void update($, panel, x => ({ ...x, showActivity: !x.showActivity }))} />
          {p.showActivity && busy.length === 0 && timeline.length === 0 && <Text dimColor>Nothing yet. Each reply and job shows up here with the tokens it took.</Text>}
          {p.showActivity && summary !== '' && <Text dimColor wrap="wrap">{summary}</Text>}
          {p.showActivity && busy.map(r => (
            <Box key={`act-${r.id}`} flexDirection="row" columnGap={1}>
              <Text color="#D97757">●</Text>
              <Text wrap="wrap">{jobOf(r.tool)}{r.label ? <Text dimColor>: {r.label.slice(0, 44)}</Text> : ''}</Text>
            </Box>
          ))}
          {p.showActivity && rows.map(r => {
            const name = r.kind === 'reply' ? 'Replied' : `${jobOf(r.tool)}${r.label ? `: ${shortLabel(r.label)}` : ''}`
            const value = `${r.kind === 'job' ? '~' : ''}${fmtTokens(r.tokens)}`
            const isOpen = p.job === r.id
            return (
              <Box key={`job-${r.id}`} flexDirection="column">
                {pressable(`job-p-${r.id}`, JOB_H, Svg ? jobSvg(W, r.isError ? BAD : r.kind === 'reply' ? '#D97757' : GOOD, name, value, isOpen) : '', `${name}, ${value} tokens`, () => void update($, panel, x => ({ ...x, job: isOpen ? '' : r.id })))}
                {isOpen && (
                  <Box key={`job-w-${r.id}`} flexDirection="column" rowGap={1} paddingY={1}>
                    {explainRow(r).map((t, i) => <Text key={`job-t-${r.id}-${i}`}>{t}</Text>)}
                  </Box>
                )}
              </Box>
            )
          })}
          {p.showActivity && timeline.length > 10 && <Button key="more-jobs" plain label={p.moreJobs ? 'Show fewer' : `Show more (${Math.min(timeline.length, 40)})`} onPress={() => void update($, panel, x => ({ ...x, moreJobs: !x.moreJobs }))} />}
          {p.showActivity && l.files.length > 0 && <Text dimColor wrap="wrap">Files touched: {l.files.map(f => shortLabel(f)).slice(-8).join(', ')}</Text>}
          {p.showActivity && apps.length > 0 && <Text dimColor wrap="wrap">Apps used: {apps.join(', ')}</Text>}
          {p.showActivity && l.skills.length > 0 && <Text dimColor wrap="wrap">Skills used: {l.skills.join(', ')}</Text>}
        </Box>
      </Box>
    )
  })
}
