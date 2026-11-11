#!/usr/bin/env python3
"""Reads local Claude Code chat logs and prints usage as JSON. Nothing leaves this computer.

usage: scan.py <session id> <5-hour window start, ms> <weekly window start, ms>

Only token counts, tool names, file paths and short labels are read out. Message
text is never printed. Figures per chat survive a deleted log in the state file,
for as long as the weekly window can still need them.
"""
import calendar, glob, json, os, re, sys, time

HOME = os.path.expanduser('~')
ROOT = os.path.join(HOME, '.claude', 'projects')
# The desktop app's folder, where it keeps its last plan reading and chat titles.
# Missing (no desktop app, or another layout) only means fewer figures, never an error.
if sys.platform == 'darwin':
    APP = os.path.join(HOME, 'Library', 'Application Support', 'Claude')
elif sys.platform.startswith('win'):
    APP = os.path.join(os.environ.get('APPDATA') or os.path.join(HOME, 'AppData', 'Roaming'), 'Claude')
else:
    APP = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config'), 'Claude')
STATE = os.path.join(HOME, '.claude', 'usage-desk', 'scan-state.json')
KEEP = 8 * 24 * 3600 * 1000

# List prices per million tokens, from platform.claude.com/docs/en/about-claude/pricing
# (checked 2026-11-05): input, output, cache read, 1-hour cache write, 5-minute cache write.
PRICES = [
    (r'(fable|mythos)-5-1', (10, 50, .25, 20, 12.5)), (r'fable|mythos', (10, 50, 1, 20, 12.5)),
    (r'opus-5-5', (4, 20, .2, 8, 5)), (r'opus', (5, 25, .5, 10, 6.25)),
    (r'sonnet-5-5', (2, 10, .1, 4, 2.5)), (r'sonnet-5', (2, 10, .2, 4, 2.5)), (r'sonnet', (3, 15, .3, 6, 3.75)),
    (r'haiku-5-5', (.1, .5, .01, .2, .125)), (r'haiku', (1, 5, .1, 2, 1.25)),
]
HAIKU_LONG = (.5, 2.5, .05, 1, .625)  # Haiku 5.5 when a prompt is over 100,000 tokens

def price(model):
    for pattern, p in PRICES:
        if re.search(pattern, model or ''):
            return p
    return (4, 20, .2, 8)

def stamp(text):
    try:
        return calendar.timegm(time.strptime(text[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
    except Exception:
        return 0

def lines(path):
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            try:
                yield json.loads(line)
            except Exception:
                continue

def cost_of(model, usage):
    i, o, w, r = counts(usage)
    q = HAIKU_LONG if re.search(r'haiku-5-5', model or '') and i + w + r > 100000 else price(model)
    five = (usage.get('cache_creation') or {}).get('ephemeral_5m_input_tokens') or 0
    return (i * q[0] + o * q[1] + r * q[2] + (w - min(five, w)) * q[3] + min(five, w) * q[4]) / 1e6

def counts(usage):
    return (usage.get('input_tokens') or 0, usage.get('output_tokens') or 0,
            usage.get('cache_creation_input_tokens') or 0, usage.get('cache_read_input_tokens') or 0)

def parse_file(path):
    """One log's replies, once each (a reply spans several rows)."""
    replies, cwd, title = {}, '', ''
    for row in lines(path):
        cwd = row.get('cwd') or cwd
        title = row.get('customTitle') or title
        msg = row.get('message')
        if row.get('type') != 'assistant' or not isinstance(msg, dict) or not msg.get('usage'):
            continue
        model = msg.get('model') or ''
        if model.startswith('<'):
            continue
        replies[msg.get('id') or row.get('uuid')] = (stamp(row.get('timestamp') or ''), model, msg['usage'])
    out = {}
    cutoff = int(time.time() * 1000) - KEEP
    for key, (at, model, usage) in replies.items():
        if at >= cutoff:  # older replies can no longer fall in the weekly window
            i, o, w, r = counts(usage)
            out[key] = [at, i, o, w, r, cost_of(model, usage)]
    return {'cwd': cwd, 'title': title, 'replies': out}

def session_of(path):
    """A subagent's log counts towards the chat that started it."""
    rel = os.path.relpath(path, ROOT).split(os.sep)
    return rel[1][:-6] if len(rel) == 2 else rel[1]

def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {'files': {}}

def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = f'{STATE}.{os.getpid()}'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE)

def desktop_titles():
    titles = {}
    for path in glob.glob(os.path.join(APP, 'claude-code-sessions', '*', '*', 'local_*.json')):
        try:
            with open(path) as f:
                d = json.load(f)
            for key in ('cliSessionId', 'lastAssistantCliSessionId'):
                if d.get(key) and d.get('title'):
                    titles[d[key]] = d['title']
        except Exception:
            continue
    return titles

def project_name(cwd):
    if not cwd or 'scratch-workspaces' in cwd:
        return 'No folder'
    return os.path.basename(cwd.rstrip('/\\')) or cwd

def refresh():
    state = load_state()
    files = state.setdefault('files', {})
    seen = set()
    for path in glob.glob(os.path.join(ROOT, '**', '*.jsonl'), recursive=True):
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        sig = [st.st_mtime_ns, st.st_size]
        entry = files.get(path)
        if entry and entry.get('sig') == sig and 'replies' in entry:
            continue
        files[path] = dict(parse_file(path), sig=sig, sid=session_of(path))
    # A deleted log keeps its figures until its last reply is too old to matter.
    cutoff = int(time.time() * 1000) - KEEP
    for path in list(files):
        if path not in seen and not any(r[0] >= cutoff for r in files[path].get('replies', {}).values()):
            del files[path]
    try:
        save_state(state)
    except OSError:
        pass
    return files

def window(files, start, titles):
    chats, projects = {}, {}
    total = [0, 0, 0, 0, 0.0, 0]
    # Resuming a chat copies its replies into a new log: each reply counts once, under
    # the newest log that holds it, so a resumed chat stays one chat.
    seen = {}
    alias = {}
    ordered = sorted(files.items(), key=lambda kv: -(kv[1].get('sig') or [0])[0])
    for path, entry in ordered:
        own = entry.get('sid') or session_of(path)
        for key in entry.get('replies', {}):
            if key in seen and seen[key] != own:
                alias.setdefault(own, seen[key])
            seen.setdefault(key, own)
    counted = set()
    for path, entry in ordered:
        for key, (at, i, o, w, r, cost) in entry.get('replies', {}).items():
            if key in counted:
                continue
            counted.add(key)
            if at < start:
                continue
            sid = entry.get('sid') or session_of(path)
            hops = 0
            while sid in alias and hops < 20:  # a chat resumed more than once
                sid, hops = alias[sid], hops + 1
            c = chats.setdefault(sid, {'id': sid, 'title': '', 'project': '', 'input': 0, 'output': 0, 'cacheWrite': 0, 'cacheRead': 0, 'weight': 0.0, 'replies': 0, 'lastAt': 0})
            c['input'] += i; c['output'] += o; c['cacheWrite'] += w; c['cacheRead'] += r
            c['weight'] += cost; c['replies'] += 1; c['lastAt'] = max(c['lastAt'], at)
            c['title'] = titles.get(sid) or entry.get('title') or c['title']
            c['project'] = c['project'] or project_name(entry.get('cwd') or '')
            for n, v in enumerate((i, o, w, r, cost, 1)):
                total[n] += v
    weight = total[4] or 1
    rows = sorted(chats.values(), key=lambda c: -c['weight'])
    for c in rows:
        c['share'] = round(c['weight'] / weight * 100, 1)
        c['title'] = c['title'] or f"Chat {c['id'][:8]}"
        p = projects.setdefault(c['project'], {'name': c['project'], 'share': 0.0, 'chats': 0})
        p['share'] = round(p['share'] + c['share'], 1)
        p['chats'] += 1
    return {'start': start, 'input': total[0], 'output': total[1], 'cacheWrite': total[2], 'cacheRead': total[3], 'replies': total[5], 'chats': rows[:15], 'chatCount': len(rows), 'projects': sorted(projects.values(), key=lambda p: -p['share'])[:8]}

def est(chars):
    return int(chars / 4)

def size(value):
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return sum(size(v) for v in value)
    if isinstance(value, dict):
        if value.get('type') == 'image':
            return 6000
        if 'text' in value:
            return size(value['text'])
        if 'content' in value:
            return size(value['content'])
        return len(json.dumps(value))
    return 0

def label_of(block):
    inp = block.get('input') or {}
    for key in ('file_path', 'path', 'notebook_path', 'url', 'query', 'pattern', 'description', 'skill', 'command'):
        if isinstance(inp.get(key), str) and inp[key]:
            return inp[key].splitlines()[0][:240]
    return ''

def chat(sid):
    paths = glob.glob(os.path.join(ROOT, '*', f'{sid}.jsonl')) if sid else []
    out = {'found': bool(paths), 'yourMessages': 0, 'replies': 0, 'toolCalls': 0, 'yourTokens': 0, 'claudeTokens': 0, 'thinkingTokens': 0, 'toolInputTokens': 0, 'toolResultTokens': 0, 'tools': [], 'connectors': [], 'files': [], 'largest': [], 'input': 0, 'output': 0, 'cacheWrite': 0, 'cacheRead': 0, 'coldRebuilds': 0, 'coldTokens': 0, 'ttl': 'unknown', 'subagents': [], 'compactions': 0, 'timeline': [], 'appTokens': 0, 'cost': 0.0, 'subagentCost': 0.0, 'subagentTokens': 0}
    if not paths:
        return out
    uses, tools, files, results, replies = {}, {}, {}, [], {}
    steps, jobs = {}, {}  # the timeline survives a compaction, unlike the rest
    models, at_of, kept_from = {}, {}, ''
    for row in lines(paths[0]):
        kind = row.get('type')
        if kind == 'system' and row.get('subtype') == 'compact_boundary':
            # Only what came after the last compaction still sits in the context.
            out['compactions'] += 1
            out.update(yourMessages=0, toolCalls=0, yourTokens=0, claudeTokens=0, toolInputTokens=0, toolResultTokens=0, appTokens=0)
            kept_from = row.get('timestamp') or ''
            uses, tools, files, results = {}, {}, {}, []
            continue
        if kind == 'attachment':
            # Reminders, tool lists and other text the app adds to the chat.
            out['appTokens'] += est(len(json.dumps(row.get('attachment'))))
            continue
        msg = row.get('message')
        if kind not in ('user', 'assistant') or not isinstance(msg, dict) or row.get('isSidechain'):
            continue
        content = msg.get('content')
        if kind == 'assistant':
            step = steps.setdefault(msg.get('id') or row.get('uuid'), {'at': stamp(row.get('timestamp') or ''), 'hasText': False, 'jobs': []})
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get('type') == 'text' and (block.get('text') or '').strip():
                    step['hasText'] = True
                elif isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('id') not in jobs:
                    jobs[block.get('id')] = {'id': block.get('id'), 'tool': block.get('name') or 'tool', 'label': label_of(block), 'request': est(len(json.dumps(block.get('input')))), 'result': 0, 'isError': False}
                    step['jobs'].append(block.get('id'))
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') in jobs:
                    job = jobs[block['tool_use_id']]
                    job['result'] = est(size(block.get('content')))
                    job['isError'] = bool(block.get('is_error'))
        if kind == 'assistant' and msg.get('usage') and not (msg.get('model') or '').startswith('<'):
            replies[msg.get('id') or row.get('uuid')] = msg['usage']
            models[msg.get('id') or row.get('uuid')] = msg.get('model') or ''
            at_of[msg.get('id') or row.get('uuid')] = row.get('timestamp') or ''
        if isinstance(content, str):
            if kind == 'user':
                out['yourMessages'] += 1
                out['yourTokens'] += est(len(content))
            continue
        typed = False
        for block in content or []:
            if not isinstance(block, dict):
                continue
            t = block.get('type')
            if t == 'text':
                if kind == 'user':
                    out['yourTokens'] += est(len(block.get('text') or '')); typed = True
                else:
                    out['claudeTokens'] += est(len(block.get('text') or ''))
            elif t == 'tool_use':
                out['toolCalls'] += 1
                out['toolInputTokens'] += est(len(json.dumps(block.get('input'))))
                uses[block.get('id')] = (block.get('name') or 'tool', label_of(block))
            elif t == 'tool_result':
                name, label = uses.get(block.get('tool_use_id'), ('tool', ''))
                tokens = est(size(block.get('content')))
                out['toolResultTokens'] += tokens
                g = tools.setdefault(name, [0, 0])
                g[0] += 1; g[1] += tokens
                results.append({'tool': name, 'label': label, 'tokens': tokens})
                if name == 'Read' and label:
                    f = files.setdefault(label, [0, 0])
                    f[0] += 1; f[1] += tokens
        if kind == 'user' and typed:
            out['yourMessages'] += 1
    for key, usage in replies.items():
        i, o, w, r = counts(usage)
        out['cost'] += cost_of(models.get(key), usage)
        # Thinking text is not kept in the log; the reply's own count says how much there was.
        if at_of.get(key, '') >= kept_from:
            out['thinkingTokens'] += (usage.get('output_tokens_details') or {}).get('thinking_tokens') or 0
        out['input'] += i; out['output'] += o; out['cacheWrite'] += w; out['cacheRead'] += r
        if w > r and w > 5000:
            out['coldRebuilds'] += 1
            out['coldTokens'] += w
        cc = usage.get('cache_creation') or {}
        if cc.get('ephemeral_1h_input_tokens'):
            out['ttl'] = '1h'
        elif cc.get('ephemeral_5m_input_tokens'):
            out['ttl'] = '5m'
    out['replies'] = len(replies)
    timeline = []
    for key, step in steps.items():
        usage = replies.get(key)
        if not usage:
            continue
        i, o, w, r = counts(usage)
        reread, fresh = r, i + w
        if step['hasText']:
            thinking = (usage.get('output_tokens_details') or {}).get('thinking_tokens') or 0
            timeline.append({'id': key, 'kind': 'reply', 'tool': '', 'label': '', 'at': step['at'], 'tokens': o, 'thinking': thinking, 'reread': reread, 'fresh': fresh, 'isError': False})
        for job_id in step['jobs']:
            job = jobs[job_id]
            timeline.append({'id': job_id, 'kind': 'job', 'tool': job['tool'], 'label': job['label'], 'at': step['at'], 'tokens': job['request'] + job['result'], 'thinking': 0, 'reread': reread, 'fresh': fresh, 'isError': job['isError']})
    out['timeline'] = timeline[-40:]
    connectors = {}
    plain = []
    for name, (calls, tokens) in tools.items():
        if name.startswith('mcp__'):
            server = name.split('__')[1]
            c = connectors.setdefault(server, [0, 0])
            c[0] += calls; c[1] += tokens
        else:
            plain.append({'name': name, 'calls': calls, 'tokens': tokens})
    out['tools'] = sorted(plain, key=lambda x: -x['tokens'])[:10]
    out['connectors'] = sorted(({'name': k, 'calls': v[0], 'tokens': v[1]} for k, v in connectors.items()), key=lambda x: -x['tokens'])[:10]
    out['files'] = sorted(({'path': k, 'reads': v[0], 'tokens': v[1]} for k, v in files.items()), key=lambda x: -x['tokens'])[:10]
    out['largest'] = sorted(results, key=lambda x: -x['tokens'])[:6]
    base = paths[0][:-6]
    for path in sorted(glob.glob(os.path.join(base, '**', '*.jsonl'), recursive=True)):
        total, count = 0, 0
        seen = {}
        for row in lines(path):
            msg = row.get('message')
            if row.get('type') == 'assistant' and isinstance(msg, dict) and msg.get('usage'):
                seen[msg.get('id')] = (msg.get('model') or '', msg['usage'])
        for model, usage in seen.values():
            i, o, w, r = counts(usage)
            total += i + o + w + r; count += 1
            out['subagentCost'] += cost_of(model, usage)
        out['subagentTokens'] += total
        out['subagents'].append({'id': os.path.basename(path)[:-6], 'tokens': total, 'replies': count})
    return out

def plan_history():
    try:
        with open(os.path.join(APP, 'plan-usage-history.json')) as f:
            samples = json.load(f).get('samples') or []
        last = samples[-1]
        return {'at': last['t'], 'five': last['u'].get('fh'), 'week': last['u'].get('sd')}
    except Exception:
        return None

def main(argv):
    sid = argv[1] if len(argv) > 1 else ''
    now = int(time.time() * 1000)
    five = int(argv[2]) if len(argv) > 2 else now - 5 * 3600 * 1000
    week = int(argv[3]) if len(argv) > 3 else now - 7 * 24 * 3600 * 1000
    files = refresh()
    titles = desktop_titles()
    print(json.dumps({'at': now, 'five': window(files, five, titles), 'week': window(files, week, titles), 'chat': chat(sid), 'plan': plan_history()}))

if __name__ == '__main__':
    main(sys.argv)
