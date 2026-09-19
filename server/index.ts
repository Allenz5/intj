import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'
import pty, { type IPty } from 'node-pty'

// Where the folder picker starts.
const startDir = path.resolve(process.argv[2] ?? process.cwd())
// Both are chosen in the picker: the project folder, then a workload in it.
let projectDir = ''
// <project>/.intj/<date-time>-<uuid>: the workload's md docs, plus its sessions' worktrees.
let workloadDir = ''
// The workload's path from the repo root, which is also where its docs sit in each worktree.
let workloadRel = ''
// The agent is just a command run in a terminal, so any CLI agent can be swapped in.
// Mutable so the picker can set it before the main terminal starts.
let agentCmd = process.env.INTJ_AGENT ?? 'claude'
// Directories a session's worktree is cone-checked-out to; empty means a full checkout. Set from the
// picker (or INTJ_SPARSE) to speed up worktree creation on a huge repo.
const parseCone = (s: string) => s.split(/[\s:,]+/).filter(Boolean)
let sparseCone = parseCone(process.env.INTJ_SPARSE ?? '')
const port = Number(process.env.PORT ?? 5173)

// Git runs off the event loop: on a large repo a status/worktree call takes seconds, and a
// synchronous call would freeze the whole server (every request would hang) while it ran.
const execFileP = promisify(execFile)
const git = async (args: string[], cwd = projectDir, env = process.env) =>
  (await execFileP('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 })).stdout

// ---- Project and workload ----

const WORKLOAD = /^\d{8}-\d{4}-[0-9a-f-]{36}$/

async function openProject(dir: string) {
  projectDir = fs.realpathSync(dir)
  try {
    await git(['rev-parse', '--git-dir'])
  } catch {
    await git(['init'])
  }
  // The whole .intj tree stays out of git: docs are never committed or pushed, and each session's
  // worktree gets them copied in. Doc changes are 3-way merged back with git merge-file, not git merge.
  const excludeFile = path.resolve(projectDir, (await git(['rev-parse', '--git-dir'])).trim(), 'info', 'exclude')
  let text = readDoc(excludeFile)
  if (!/^\.intj\/?$/m.test(text)) text += '\n.intj/\n'
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.writeFileSync(excludeFile, text)
  return listWorkloads()
}

// Newest first, each titled by its root doc's first heading.
function listWorkloads() {
  const root = path.join(projectDir, '.intj')
  const ids = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => WORKLOAD.test(n)).sort().reverse() : []
  return ids.map((id) => ({ id, title: readDoc(path.join(root, id, 'main.md')).match(/^#\s+(.+)/m)?.[1] ?? '' }))
}

// Open a workload, or create one when no id is given.
async function openWorkload(id?: string) {
  if (!id) {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    id = `${stamp}-${crypto.randomUUID()}`
  }
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.intj', id)
  if (!fs.existsSync(dir)) {
    // Docs are not tracked; a session's worktree gets them copied in, so no commit is needed.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.md'), `# ${path.basename(projectDir)}\n`)
  }
  workloadDir = dir
  workloadRel = path.relative((await git(['rev-parse', '--show-toplevel'])).trim(), dir)
  watchDocs()
}

// Delete a workload: end its sessions (dropping their worktrees/branches), then remove its folder.
async function deleteWorkload(id: string) {
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.intj', id)
  for (const s of [...sessions.values()]) {
    if (s.worktree.startsWith(dir + path.sep)) await endSession(s)
  }
  // Docs are untracked, so nothing to commit: just drop the folder and prune stale worktrees.
  if (workloadDir === dir) closeDocWatcher()
  fs.rmSync(dir, { recursive: true, force: true })
  await git(['worktree', 'prune'])
  if (workloadDir === dir) {
    workloadDir = ''
    workloadRel = ''
  }
  return listWorkloads()
}

// ---- Agent terminals ----

type AgentTerm = {
  // 'creating' while a session's worktree is still being built, before its pty exists.
  status: 'creating' | 'running' | 'exited'
  // Whether the agent is working on a turn, as opposed to waiting for input.
  busy: boolean
  term: IPty | null
  buffer: string
  clients: Set<WebSocket>
}
const MAX_BUFFER = 500_000
// Claude Code reports its state in the terminal title: a spinning glyph while working, ✳ when waiting.
const TITLE = /\x1b\]0;([^\x07]*)\x07/g

const newTerm = (): AgentTerm => ({ status: 'creating', busy: true, term: null, buffer: '', clients: new Set() })

// Start the pty for a term object; its callbacks update that same object in place, so a session
// created earlier (in the 'creating' state) simply gets its terminal filled in here.
function startTerm(t: AgentTerm, cwd: string, command: string, env: Record<string, string> = {}) {
  const term = pty.spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', command], {
    name: 'xterm-256color',
    cwd,
    cols: 100,
    rows: 30,
    env: { ...process.env, COLORTERM: 'truecolor', ...env },
  })
  t.term = term
  t.status = 'running'
  t.busy = true
  // It titles itself ✳ while booting, before it picks up the first prompt; ignore that one.
  let working = false
  const setBusy = (busy: boolean) => {
    if (t.busy === busy) return
    t.busy = busy
    // Sessions extend this object, so an id means this terminal is a session's.
    const id = (t as Partial<Session>).id
    // An ended session's worktree is gone, so skip its late output.
    if (id) {
      if (sessions.has(id)) {
        broadcast({ type: 'activity', id, busy, unmerged: unmergedCache.get(id) ?? false })
        // Recompute the merge state off the event loop rather than blocking on git here.
        refreshUnmerged(t as Session)
      }
    }
    // The main terminal may have just merged a handed-off session.
    else if (!busy) broadcastSessions()
  }
  term.onData((data) => {
    // Keep recent output so a terminal opened later (or after a page reload) shows history.
    t.buffer = (t.buffer + data).slice(-MAX_BUFFER)
    for (const ws of t.clients) ws.send(data)
    for (const [, title] of data.matchAll(TITLE)) {
      const idle = title.startsWith('✳')
      if (!idle) working = true
      if (working) setBusy(!idle)
    }
  })
  term.onExit(() => {
    t.status = 'exited'
    for (const ws of t.clients) ws.send('\r\n[process exited]\r\n')
    broadcastSessions()
  })
  return t
}

const spawnAgent = (cwd: string, command: string, env: Record<string, string> = {}) =>
  startTerm(newTerm(), cwd, command, env)

// The default terminal: a plain agent session on the main checkout, restarted if it has exited.
let mainTerm: AgentTerm | null = null
const getMainTerm = () => {
  if (mainTerm?.status !== 'running') mainTerm = spawnAgent(projectDir, agentCmd)
  return mainTerm
}

// ---- Sessions: one agent terminal per worktree ----

type Session = AgentTerm & {
  id: string
  // The doc the session was started from; its card shows only there.
  doc: string
  quote: string
  // The text around the quote and its relative position, so the client can find it again after edits.
  prefix: string
  suffix: string
  pos: number
  prompt: string
  branch: string
  worktree: string
  // The agent's conversation id, so a fork can continue the conversation.
  chat: string
  // Each doc's content when the session started, its 3-way-merge base for merging changes back.
  docBase: Record<string, string>
}

// The workload's doc files (paths relative to `root`), excluding the session worktrees under it.
function listDocs(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name === 'worktrees') continue
      const r = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(r)
      else if (e.name.endsWith('.md')) out.push(r)
    }
  }
  if (fs.existsSync(root)) walk('')
  return out
}

// Whether the session changed any doc versus the base it started from.
function docsDiffer(s: Session) {
  const dir = path.join(s.worktree, workloadRel)
  for (const rel of new Set([...listDocs(dir), ...Object.keys(s.docBase)])) {
    if (readDoc(path.join(dir, rel)) !== (s.docBase[rel] ?? '')) return true
  }
  return false
}

// A 3-way merge of plain files via git merge-file (no repo needed); on conflict the returned text
// carries conflict markers.
async function mergeFile3(ours: string, base: string, theirs: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intj-merge-'))
  const o = path.join(tmp, 'ours')
  const b = path.join(tmp, 'base')
  const t = path.join(tmp, 'theirs')
  try {
    fs.writeFileSync(o, ours)
    fs.writeFileSync(b, base)
    fs.writeFileSync(t, theirs)
    try {
      const out = await git(['merge-file', '-p', '-L', 'current', '-L', 'base', '-L', 'session', o, b, t])
      return { text: out, conflict: false }
    } catch (e: any) {
      // Non-zero exit means conflicts; stdout still holds the merged text with markers.
      return { text: e.stdout?.toString() ?? theirs, conflict: true }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Bring the workload's current docs into a session's worktree, 3-way against its base, and advance the
// base to them, so the session works on (and its Merge preview shows) what other sessions merged. A
// doc that conflicts is left alone unless `markers` is set, when it gets the conflict-marked text.
// Returns the docs that conflicted.
async function syncDocs(s: Session, markers = false) {
  const dir = path.join(s.worktree, workloadRel)
  const conflicts: string[] = []
  for (const rel of new Set([...listDocs(workloadDir), ...Object.keys(s.docBase)])) {
    const main = readDoc(path.join(workloadDir, rel))
    const base = s.docBase[rel] ?? ''
    if (main === base) continue
    const file = path.join(dir, rel)
    const mine = readDoc(file)
    let text = main
    if (mine !== base && mine !== main) {
      const m = await mergeFile3(main, base, mine)
      if (m.conflict) {
        conflicts.push(rel)
        if (!markers) continue
      }
      text = m.text
    }
    if (text !== mine) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    s.docBase[rel] = main
  }
  return conflicts
}

// Keep every live session's docs current after the workload's docs change.
let syncTimer: ReturnType<typeof setTimeout> | undefined
function syncAllDocs() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(async () => {
    for (const s of sessions.values()) {
      // Sessions of another workload, and ones still copying their docs in, have nothing to sync.
      if (s.status === 'creating' || !s.worktree.startsWith(workloadDir + path.sep)) continue
      try {
        await syncDocs(s)
      } catch {}
    }
  }, 300)
}

const hasMarkers = (text: string) => /^(<{7} current|>{7} session)$/m.test(text)

// Merge the session's doc edits back into the workload. First sync the workload into the session, so
// what remains is a plain copy; a doc that conflicts gets conflict markers in the session's worktree
// (never in the workload) and is left for the merge-doc skill. Returns the docs that conflicted,
// including any whose markers are still unresolved from an earlier Merge.
async function mergeDocs(s: Session) {
  const conflicts = await syncDocs(s, true)
  const srcDir = path.join(s.worktree, workloadRel)
  for (const rel of new Set([...listDocs(srcDir), ...Object.keys(s.docBase)])) {
    if (conflicts.includes(rel)) continue
    const theirs = readDoc(path.join(srcDir, rel))
    if (hasMarkers(theirs)) {
      conflicts.push(rel)
      continue
    }
    if (theirs === (s.docBase[rel] ?? '')) continue // the session left this doc alone
    const oursPath = path.join(workloadDir, rel)
    fs.mkdirSync(path.dirname(oursPath), { recursive: true })
    fs.writeFileSync(oursPath, theirs)
    // Advance the base so a later merge of the same session only carries new edits.
    s.docBase[rel] = theirs
  }
  return conflicts
}

type Anchor = Pick<Session, 'quote' | 'prefix' | 'suffix' | 'pos'>
const sessions = new Map<string, Session>()

// Whether the worktree has anything main doesn't (uncommitted edits or unmerged commits), cached so
// broadcasts stay synchronous. Recomputed off the event loop, debounced, since git status on a large
// repo is slow; the card updates when the value actually changes.
const unmergedCache = new Map<string, boolean>()
const unmergedTimers = new Map<string, ReturnType<typeof setTimeout>>()
function refreshUnmerged(s: Session) {
  if (s.status === 'creating') return
  clearTimeout(unmergedTimers.get(s.id))
  unmergedTimers.set(
    s.id,
    setTimeout(async () => {
      unmergedTimers.delete(s.id)
      try {
        const dirty = (await git(['status', '--porcelain'], s.worktree)).trim() !== ''
        const ahead = (await git(['rev-list', '--count', `HEAD..${s.branch}`])).trim() !== '0'
        // Docs live outside git, so check them separately, or a doc-only session would never merge.
        const val = dirty || ahead || docsDiffer(s)
        if (sessions.has(s.id) && unmergedCache.get(s.id) !== val) {
          unmergedCache.set(s.id, val)
          broadcast({ type: 'activity', id: s.id, busy: s.busy, unmerged: val })
        }
      } catch {}
    }, 400),
  )
}

const publicSession = (s: Session) => {
  const { id, doc, quote, prefix, suffix, pos, prompt, branch, status, busy } = s
  return { id, doc, quote, prefix, suffix, pos, prompt, branch, status, busy, unmerged: unmergedCache.get(id) ?? false }
}
const broadcastSessions = () => broadcast({ type: 'sessions', list: [...sessions.values()].map(publicSession) })

// A commit of the worktree as it is now, uncommitted and untracked files included, leaving its index alone.
async function snapshot(s: Session) {
  const index = path.join(os.tmpdir(), `intj-index-${crypto.randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    await git(['add', '-A'], s.worktree, env)
    const tree = (await git(['write-tree'], s.worktree, env)).trim()
    const head = (await git(['rev-parse', 'HEAD'], s.worktree)).trim()
    if (tree === (await git(['rev-parse', 'HEAD^{tree}'], s.worktree)).trim()) return head
    return (await git(['commit-tree', tree, '-p', head, '-m', `intj ${s.id}: snapshot for fork`], s.worktree)).trim()
  } finally {
    fs.rmSync(index, { force: true })
  }
}

// Claude Code keeps each conversation at <config>/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl
// and --resume only looks in the current cwd's folder. A fork runs in a new worktree, so copy the
// source conversation into that worktree's folder first (it's written as the chat goes, so a running
// chat can be forked too).
function copyChat(chat: string, worktree: string) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const name = `${chat}.jsonl`
  const src = fs.existsSync(projects)
    ? fs.readdirSync(projects).map((d) => path.join(projects, d, name)).find((p) => fs.existsSync(p))
    : undefined
  if (!src) throw new Error(`Conversation ${chat} not found under ${projects}`)
  const dst = path.join(projects, worktree.replace(/[^a-zA-Z0-9]/g, '-'), name)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

// With a skill, the prompt becomes the skill's optional argument and leads the message,
// since the agent only recognizes a slash command at the start.
// With `from`, the session starts from that session's files and conversation as they are now.
// The card is shown at once in a 'creating' state; the worktree is built and the agent started
// off the event loop, so a slow repo doesn't block the request or freeze the server.
function startSession(doc: string, anchor: Anchor, prompt: string, skill?: string, from?: Session) {
  const { quote } = anchor
  const id = crypto.randomBytes(3).toString('hex')
  const branch = `intj/${id}`
  const worktree = path.join(workloadDir, 'worktrees', id)
  const chat = crypto.randomUUID()
  // For a skill the message leads with the slash command; this is also what the card shows.
  const cmd = skill ? `/intj:${skill} ${prompt}`.trim() : prompt
  const s: Session = Object.assign(newTerm(), { id, doc, ...anchor, prompt: cmd, branch, worktree, chat, docBase: {} })
  sessions.set(id, s)
  broadcastSessions()

  ;(async () => {
    try {
      const startPoint = from ? await snapshot(from) : 'HEAD'
      // Materializing a huge repo's whole tree is the bottleneck. When INTJ_SPARSE names directories,
      // do a cone checkout of just those (with a sparse index) so creation and later git ops touch far
      // fewer files; otherwise check out the full tree.
      const cone = sparseCone
      if (cone.length) {
        await git(['worktree', 'add', '--no-checkout', '-b', branch, worktree, startPoint])
        await git(['sparse-checkout', 'init', '--cone', '--sparse-index'], worktree)
        await git(['sparse-checkout', 'set', ...cone], worktree)
        await git(['checkout'], worktree)
      } else {
        await git(['worktree', 'add', '-b', branch, worktree, startPoint])
      }
      // Docs are outside git: copy the workload's docs into the worktree and record each one's
      // content as this session's merge base. A fork starts from its source session's docs.
      const srcDocDir = from ? path.join(from.worktree, workloadRel) : workloadDir
      const destDocDir = path.join(worktree, workloadRel)
      for (const rel of listDocs(srcDocDir)) {
        const src = path.join(srcDocDir, rel)
        const dst = path.join(destDocDir, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        s.docBase[rel] = readDoc(src)
      }
      const quoted = quote ? quote.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : ''
      // The doc's copy in this session's worktree, which is the one the agent should update.
      const file = path.join(worktree, workloadRel, doc)
      const context =
        `Doc: ${file}\n\n${quoted && `Selected text:\n${quoted}`}${prompt && `Comment: ${prompt}\n\n`}` +
        `When done, use the intj:update-docs skill to update the markdown docs in ${path.dirname(file)}.`
      let text = skill ? `${cmd}\n\n${context}` : context
      // The forked conversation names the old worktree's paths, so point the agent at its own copy.
      if (from) text = `(Forked: you now work in ${worktree}, a copy of ${from.worktree}. Edit files here only.)\n\n${text}`
      if (from) copyChat(from.chat, worktree)
      const resume = from ? `--resume ${from.chat} --fork-session ` : ''
      // Pass the prompt through the environment to avoid shell quoting issues.
      startTerm(s, worktree, `${agentCmd} ${resume}--session-id ${chat} "$INTJ_PROMPT"`, { INTJ_PROMPT: text })
      broadcastSessions()
    } catch (e) {
      // Building the worktree failed: drop the placeholder card and report it.
      sessions.delete(id)
      unmergedCache.delete(id)
      broadcastSessions()
      broadcast({ type: 'session-error', id, error: errorText(e) })
    }
  })()
  return s
}

// Whether the worktree is in the middle of a git merge (its conflicts not yet committed).
const midMerge = async (dir: string) => {
  try {
    await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], dir)
    return true
  } catch {
    return false
  }
}

// Conflicts are resolved in the session's worktree, never on the current branch: docs get markers in
// the session's copy, and when the code won't merge cleanly the current branch is merged into the
// session's branch instead. The session's agent resolves both; the next Merge is then clean.
async function mergeSession(s: Session) {
  if (await midMerge(s.worktree)) throw new Error('The worktree is still resolving merge conflicts; Merge again once they are committed')
  // Merge docs first (outside git) so they land even if the code conflicts.
  const docConflicts = await mergeDocs(s)
  // Merge the code via git; docs are ignored, so only real code is committed and merged.
  await git(['add', '-A'], s.worktree)
  if ((await git(['status', '--porcelain'], s.worktree)).trim()) {
    await git(['commit', '-m', `intj ${s.id}: ${s.prompt.split('\n')[0]}`], s.worktree)
  }
  let codeConflict = false
  try {
    await git(['merge', '--no-edit', s.branch])
  } catch (e) {
    try {
      await git(['merge', '--abort'])
    } catch {}
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const target = current === 'HEAD' ? (await git(['rev-parse', 'HEAD'])).trim() : current
    try {
      await git(['merge', '--no-edit', target], s.worktree)
    } catch (e2) {
      // Anything other than a conflict (which leaves the merge in progress) is a real error.
      if (!(await midMerge(s.worktree))) throw e2
      codeConflict = true
    }
    // The session now contains the current branch, so this merge is a fast-forward; if it still fails,
    // the cause wasn't a conflict (a dirty checkout, say), so report it.
    if (!codeConflict) await git(['merge', '--no-edit', s.branch])
  }
  if (docConflicts.length || codeConflict) handOffConflicts(s, docConflicts, codeConflict)
  return { docConflicts, codeConflict }
}

// Ask the session's own agent, which knows what it meant, to resolve its conflicts in the worktree.
function handOffConflicts(s: Session, docs: string[], code: boolean) {
  const files = docs.map((rel) => path.join(s.worktree, workloadRel, rel)).join(' ')
  const codeText =
    'Merging the current branch into this worktree hit git conflicts (git status lists them). Resolve them ' +
    'keeping the intent of both sides, git add the files, then git commit --no-edit.'
  const text = docs.length ? `/intj:merge-doc ${files}${code ? ` — then: ${codeText}` : ''}` : codeText
  if (s.status === 'running') {
    s.term!.write(text)
    // Send Enter separately so the TUI doesn't treat it as part of a paste.
    setTimeout(() => s.term?.write('\r'), 300)
  } else {
    startTerm(s, s.worktree, `${agentCmd} --resume ${s.chat} "$INTJ_PROMPT"`, { INTJ_PROMPT: text })
  }
}

async function endSession(s: Session) {
  s.term?.kill()
  for (const ws of s.clients) ws.close()
  // The worktree may not exist yet if the session is still being created.
  try {
    await git(['worktree', 'remove', '--force', s.worktree])
  } catch {}
  try {
    await git(['branch', '-D', s.branch])
  } catch {}
  sessions.delete(s.id)
  unmergedCache.delete(s.id)
  broadcastSessions()
}

// ---- HTTP ----

const server = http.createServer()
const vite = await createVite({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '../web'),
  server: { middlewareMode: true, hmr: { server } },
  appType: 'spa',
})

const readBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body ? JSON.parse(body) : {}))
  })

const sendJson = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const errorText = (e: any) => (e.stderr?.toString() || e.stdout?.toString() || e.message || String(e)).trim()

server.on('request', async (req, res) => {
  const { pathname: url, searchParams } = new URL(req.url ?? '', 'http://localhost')
  if (!url.startsWith('/api/')) return vite.middlewares(req, res)
  try {
    const docName = searchParams.get('name') ?? ''
    if (req.method === 'GET' && url === '/api/state') {
      return sendJson(res, 200, { workload: workloadDir && path.basename(workloadDir), agent: agentCmd, sparse: sparseCone.join(' ') })
    }
    if (req.method === 'POST' && url === '/api/agent') {
      const { command } = await readBody(req)
      agentCmd = String(command ?? '').trim() || 'claude'
      return sendJson(res, 200, { agent: agentCmd })
    }
    if (req.method === 'POST' && url === '/api/sparse') {
      const { dirs } = await readBody(req)
      sparseCone = parseCone(String(dirs ?? ''))
      return sendJson(res, 200, { sparse: sparseCone.join(' ') })
    }
    if (req.method === 'GET' && url === '/api/dirs') {
      const dir = path.resolve(searchParams.get('path') || startDir)
      const dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
      return sendJson(res, 200, { path: dir, parent: path.dirname(dir), dirs })
    }
    if (req.method === 'POST' && url === '/api/project') {
      const { path: dir } = await readBody(req)
      const workloads = await openProject(dir)
      return sendJson(res, 200, { project: projectDir, workloads })
    }
    if (req.method === 'POST' && url === '/api/workload') {
      const { id } = await readBody(req)
      await openWorkload(id)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url === '/api/workload/delete') {
      const { id } = await readBody(req)
      const workloads = await deleteWorkload(id)
      return sendJson(res, 200, { workloads })
    }
    if (req.method === 'GET' && url === '/api/doc') {
      return sendJson(res, 200, { text: readDoc(docFile(workloadDir, docName)) })
    }
    if (req.method === 'POST' && url === '/api/sessions') {
      const { doc, anchor, prompt, skill, from } = await readBody(req)
      const src = from && sessions.get(from)
      if (from && !src) return sendJson(res, 404, { error: `no session ${from}` })
      return sendJson(res, 200, publicSession(startSession(doc, anchor, prompt, skill, src)))
    }
    if (req.method === 'GET' && url === '/api/parent') {
      return sendJson(res, 200, { parent: findParent(docName) })
    }
    const d = url.match(/^\/api\/sessions\/(\w+)\/doc$/)
    const ds = d && sessions.get(d[1])
    if (req.method === 'GET' && ds) {
      // The worktree's current file, uncommitted edits included, since merge commits them.
      return sendJson(res, 200, { text: readDoc(docFile(path.join(ds.worktree, workloadRel), docName)) })
    }
    const m = url.match(/^\/api\/sessions\/(\w+)\/(merge|end)$/)
    const s = m && sessions.get(m[1])
    if (req.method === 'POST' && s) {
      if (m[2] === 'end') {
        await endSession(s)
        return sendJson(res, 200, { ok: true })
      }
      const { docConflicts, codeConflict } = await mergeSession(s)
      refreshUnmerged(s)
      broadcastSessions()
      return sendJson(res, 200, { ok: true, handedOff: docConflicts.length > 0 || codeConflict, docConflicts, codeConflict })
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    sendJson(res, 500, { error: errorText(e) })
  }
})

// ---- WebSockets ----

// A doc's path under root, refusing names that escape it.
const docFile = (root: string, name: string) => {
  const file = path.resolve(root, name)
  if (!file.startsWith(root + path.sep)) throw new Error(`invalid doc: ${name}`)
  return file
}

// Docs form a tree through links, so a doc's parent is the md file that links to it.
function findParent(name: string) {
  for (const f of listDocs(workloadDir)) {
    if (f === name) continue
    for (const [, href] of readDoc(path.join(workloadDir, f)).matchAll(/\]\(([^)\s]+)/g)) {
      if (/^([a-z]+:|\/|#)/i.test(href)) continue
      if (decodeURIComponent(path.posix.join(path.posix.dirname(f), href.split('#')[0])) === name) return f
    }
  }
  return null
}

const readDoc = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const lastText = new Map<string, string>()
const eventClients = new Set<WebSocket>()
function broadcast(msg: unknown) {
  for (const ws of eventClients) ws.send(JSON.stringify(msg))
}

// Watch the directory, not the file: editors (and agents) often save by rename, which breaks a file watch.
// Non-recursive on purpose: docs sit at the top of the workload (children go next to their parent), and
// a recursive watch would descend into the session worktrees — huge on a big repo, and it crashes the
// process when their files churn (scandir on a vanished dir emits an unhandled 'error').
let docWatcher: fs.FSWatcher | null = null
const closeDocWatcher = () => {
  docWatcher?.close()
  docWatcher = null
}
const watchDocs = () => {
  closeDocWatcher()
  docWatcher = fs.watch(workloadDir, (_event, name) => {
    if (!name?.endsWith('.md')) return
    const text = readDoc(path.join(workloadDir, name))
    if (text === lastText.get(name)) return
    lastText.set(name, text)
    broadcast({ type: 'content', name, text })
    syncAllDocs()
  })
  // A watch on a folder that gets removed still emits errors; never let one crash the server.
  docWatcher.on('error', () => {})
}

const eventsWss = new WebSocketServer({ noServer: true })
eventsWss.on('connection', (ws) => {
  eventClients.add(ws)
  ws.send(JSON.stringify({ type: 'sessions', list: [...sessions.values()].map(publicSession) }))
  ws.on('close', () => eventClients.delete(ws))
})

const ptyWss = new WebSocketServer({ noServer: true })
ptyWss.on('connection', (ws, s: AgentTerm) => {
  ws.send(s.buffer)
  s.clients.add(ws)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (s.status !== 'running' || !s.term) return
    if (msg.type === 'input') s.term.write(msg.data)
    else if (msg.type === 'resize') s.term.resize(msg.cols, msg.rows)
  })
  ws.on('close', () => s.clients.delete(ws))
})

// Vite's HMR socket shares this server, so only claim our own paths.
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? ''
  if (url === '/events') {
    eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req))
    return
  }
  const id = url.match(/^\/pty\/(\w+)$/)?.[1] ?? ''
  const s = id === 'main' ? getMainTerm() : sessions.get(id)
  if (s) ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, s))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Open http://localhost:${port}`)
})
