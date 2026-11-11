import { expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { cleanName, limitOf, categoryColor, explain, explainFiles, explainRow, fitText, fmtTokens, hexOf, jobOf, jobSummary, labelOf, modelName } from './register'

const PANE = {
  plugin: 'usage-desk',
  component: 'Pane',
  requestId: 'usage-desk',
  props: { title: 'Usage Desk', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const CHAT = { found: true, yourMessages: 200, replies: 50, toolCalls: 80, yourTokens: 5000, claudeTokens: 4000, thinkingTokens: 0, toolInputTokens: 1000, toolResultTokens: 90000, tools: [{ name: 'Bash', calls: 40, tokens: 90000 }], connectors: [], files: [{ path: '/a/big.ts', reads: 3, tokens: 9000 }], largest: [{ tool: 'Read', label: '/a/big.ts', tokens: 9000 }], input: 10, output: 100, cacheWrite: 1000, cacheRead: 5_000_000, coldRebuilds: 1, coldTokens: 80000, ttl: '1h', subagents: [], compactions: 0, timeline: [], appTokens: 3000, cost: 1, subagentCost: 0, subagentTokens: 0 }

const snap = (percent: number): Snapshot => ({ chatTokens: percent >= 50 ? 200000 : 100000, chatWindow: 200000, chatPercent: percent, five: null, week: null, breakdown: null, model: '', cost: 0, startedAt: 0, scan: { at: 0, five: { start: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, replies: 0, chats: [], chatCount: 0, projects: [] }, week: { start: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, replies: 0, chats: [], chatCount: 0, projects: [] }, chat: CHAT, plan: null } })

test('numbers and names read plainly', async () => {
  expect(fmtTokens(1500)).toBe('1.5k')
  expect(fmtTokens(2_400_000)).toBe('2.4M')
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(hexOf('#123456')).toBe('#123456')
  expect(labelOf({ file_path: '/x/y/z.ts' })).toBe('z.ts')
  expect(jobOf('WebSearch')).toBe('Searched online')
  expect(jobOf('mcp__gmail__search')).toBe('Used Gmail')
  expect(jobSummary({ Read: 2, ToolSearch: 9 })).toBe('Read a file × 2')
  expect(categoryColor('Messages')).toBe('#3B82F6')
  expect(fitText('a very long chat title indeed', 13, 40).endsWith('…')).toBe(true)
})

test('messages say why they cost so much, and offer fixes only when it pays', async () => {
  const full = explain('Messages', 100000, snap(60))
  expect(full.lines.join(' ')).toContain('200 messages')
  expect(full.lines.join(' ')).toContain('re-reads all of it')
  expect(full.fixes.map(f => f.act)).toEqual(['compact', 'handoff'])
  expect(explain('Messages', 100000, snap(10)).fixes.length).toBe(0)
})

test('a reply and a job each explain their tokens', async () => {
  const reply = explainRow({ id: 'a', kind: 'reply', tool: '', label: '', at: 0, tokens: 12, thinking: 0, reread: 40000, fresh: 5, isError: false }).join(' ')
  expect(reply).toContain('wrote 12 tokens')
  expect(reply).toContain('re-read 40k')
  const job = explainRow({ id: 'b', kind: 'job', tool: 'Read', label: 'x', at: 0, tokens: 9000, thinking: 0, reread: 0, fresh: 0, isError: false }).join(' ')
  expect(job).toContain('big file')
})

test('a file read three times is called out', async () => {
  expect(explainFiles(snap(10)).lines.join(' ')).toContain('big.ts was read 3 times')
})

test('the pane draws its bars and shows tool activity', async ($, on) => {
  on('command.register', () => ({ value: { command: 'usage-desk' } }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'List the folder' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up' } as never)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /What Claude did|Ran a command/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /wrap/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('pressing the owl opens the icon list', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'looks-t' })
  expect(await ui.find({ type: 'Text', text: /Agent icon/ })).toBeTruthy()
  await ui.unmount()
})

test('a name is tidied, and an empty one falls back', async () => {
  expect(cleanName('  Bob   the owl ')).toBe('Bob the owl')
  expect(cleanName('   ')).toBe('Main agent')
  expect(cleanName('x'.repeat(50)).length).toBe(28)
})

test('a limit past its reset reads zero, and an old saved reading is dropped', async () => {
  const at = Date.parse('2026-11-05T12:00:00Z')
  const usage = (resetsAt: string) => ({ rateLimits: [{ kind: 'five_hour', percentUsed: 80, resetsAt }] }) as never
  expect(limitOf(usage('2026-11-05T13:00:00Z'), 'five_hour', undefined, 0, at)?.percent).toBe(80)
  expect(limitOf(usage('2026-11-05T11:00:00Z'), 'five_hour', undefined, 0, at)?.percent).toBe(0)
  const none = { rateLimits: [] } as never
  expect(limitOf(none, 'five_hour', 30, at - 3600_000, at)?.isLive).toBe(false)
  expect(limitOf(none, 'five_hour', 30, at - 6 * 3600_000, at)).toBe(null)
  expect(limitOf(none, 'seven_day', 30, at - 6 * 3600_000, at)?.percent).toBe(30)
})

test('every drawn control works on the desktop, end to end', async ($, on) => {
  const row = { id: 'r1', kind: 'reply', tool: '', label: '', at: 1, tokens: 12, thinking: 0, reread: 40000, fresh: 5, isError: false }
  const chat = { ...CHAT, timeline: [row] }
  const scan = { at: 1, plan: null, chat, five: { start: 0, input: 1, output: 2, cacheWrite: 3, cacheRead: 4, replies: 1, chatCount: 1, projects: [], chats: [{ id: 'c1', title: 'A & B <chat>', project: 'No folder', input: 1, output: 2, cacheWrite: 3, cacheRead: 4, replies: 1, weight: 1, lastAt: 1, share: 100 }] }, week: { start: 0, input: 1, output: 2, cacheWrite: 3, cacheRead: 4, replies: 1, chatCount: 0, projects: [], chats: [] } }
  const breakdown = { categories: [{ name: 'Messages', tokens: 170000, color: 'x', isDeferred: false, kind: 'used' }, { name: 'Free space', tokens: 800000, color: 'y', isDeferred: false, kind: 'free' }], totalTokens: 200000, maxTokens: 1000000, rawMaxTokens: 1000000, autocompactSource: 'auto', percentage: 20, gridRows: [[{ color: 'x', isFilled: true, categoryName: 'Messages', tokens: 1, percentage: 1, squareFullness: 1 }]], model: 'claude-opus-5-5', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null }
  on('command.register', () => ({ value: { command: 'usage-desk' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-05T12:00:00Z') }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', () => ({ value: { stdout: JSON.stringify(scan), stderr: '', exitCode: 0 } as never }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: 200000, window: 1000000, percent: 20, breakdown: breakdown as never }, rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2099-01-01T00:00:00Z' }, { kind: 'seven_day', percentUsed: 47, resetsAt: '2099-01-02T00:00:00Z' }] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'usage-desk' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (re: RegExp) => ui.find({ type: 'Text', text: re })

  await ui.press({ key: 'b-chat-p0' })
  await ui.press({ key: 'cat-Messages-p0' })
  expect(await text(/re-reads all of it/)).toBeTruthy()
  await ui.press({ key: 'cat-back' })
  await ui.press({ key: 'b-five-p0' })
  expect(await text(/41% of your 5-hour limit/)).toBeTruthy()
  await ui.press({ key: 'five-c-c1-p0' })
  expect(await text(/A & B <chat>/)).toBeTruthy()
  await ui.press({ key: 'five-back' })
  await ui.press({ key: 'b-week-p0' })
  expect(await text(/47% of your weekly limit/)).toBeTruthy()
  await ui.press({ key: 'job-p-r1-p0' })
  expect(await text(/wrote 12 tokens/)).toBeTruthy()
  await ui.press({ key: 'me-p0' })
  expect(await text(/Agent icon/)).toBeTruthy()
  await ui.press({ key: 'look-fable-p0' })
  await ui.press({ key: 'hero-name-p0' })
  expect(await ui.find({ type: 'Input', key: 'rename-input' })).toBeTruthy()
  await ui.unmount()
})

test('compact runs the command, then falls back to the prompt box, and says which', async ($, on) => {
  const breakdown = { categories: [{ name: 'Messages', tokens: 170000, color: 'x', isDeferred: false, kind: 'used' }], totalTokens: 200000, maxTokens: 1000000, rawMaxTokens: 1000000, autocompactSource: 'auto', percentage: 20, gridRows: [], model: 'claude-opus-5-5', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null }
  const scan = { at: 1, plan: null, chat: CHAT, five: null, week: null }
  let ran = 0
  let isRunRefused = false
  let isFillRefused = false
  let filled = ''
  on('command.register', () => ({ value: { command: 'usage-desk' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { stdout: JSON.stringify(scan), stderr: '', exitCode: 0 } as never }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: 200000, window: 1000000, percent: 20, breakdown: breakdown as never }, rateLimits: [] } as never }))
  on('command.run', () => {
    if (isRunRefused) throw new Error('not available in this mode')
    ran += 1
    return { text: 'compacted' }
  })
  on('prompt.fill', (_, e) => {
    if (isFillRefused) return { isFilled: false } as never
    filled = e.text
    return { isFilled: true } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (re: RegExp) => ui.find({ type: 'Text', text: re })
  const pressCompact = async () => {
    await ui.press({ key: 'cat-compact' })
    await ui.press({ key: 'cat-compact' })
  }
  await ui.press({ key: 'b-chat-p0' })
  await ui.press({ key: 'cat-Messages-p0' })

  // The first press only asks for confirmation.
  const before = ran
  await ui.press({ key: 'cat-compact' })
  expect(ran).toBe(before)
  await ui.press({ key: 'cat-compact' })
  expect(ran).toBe(before + 1)
  expect(await text(/Compact ran/)).toBeTruthy()

  isRunRefused = true
  await pressCompact()
  expect(filled).toBe('/compact')
  expect(await text(/is in your prompt box/)).toBeTruthy()

  isFillRefused = true
  await pressCompact()
  expect(await text(/could not reach the prompt box/)).toBeTruthy()
  await ui.unmount()
})

test('the panel title names the installed version, and survives a missing manifest', async ($, on) => {
  const titles: string[] = []
  let manifest = JSON.stringify({ version: '9.8.7' })
  on('command.register', () => ({ value: { command: 'usage-desk' } }))
  on('ui.open', (_, e) => {
    titles.push(String(e.title))
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: 1, window: 2, percent: 1 }, rateLimits: [] } as never }))
  on('process.run', () => ({ value: { stdout: 'null', stderr: '', exitCode: 0 } as never }))
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('plugin.json') ? manifest : '' } as never))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'usage-desk' } as never)
  manifest = 'not json'
  await $.command.run({ command: 'usage-desk' } as never)
  expect(titles[0]).toBe('Usage Desk 9.8.7')
  expect(titles[titles.length - 1]).toBe('Usage Desk')
})

