import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
const agent = process.env.INTJ_AGENT ?? 'claude'
const port = Number(process.env.PORT ?? 5173)

const git = (args: string[], cwd = projectDir) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

// ---- Project and workload ----

const WORKLOAD = /^\d{8}-\d{4}-[0-9a-f-]{36}$/

function openProject(dir: string) {
  projectDir = fs.realpathSync(dir)
  try {
    git(['rev-parse', '--git-dir'])
  } catch {
    git(['init'])
  }
  // Workload docs are tracked so every worktree has them; keep only worktrees out of the main repo's
  // status, without touching tracked files.
  const excludeFile = path.resolve(projectDir, git(['rev-parse', '--git-dir']).trim(), 'info', 'exclude')
  // Older versions excluded all of .intj/, which would hide the docs; keep excluding just the worktrees there.
  let text = readDoc(excludeFile).replace(/^\.intj\/$/m, '.intj/worktrees/')
  if (!/^\.intj\/\*\/worktrees\/$/m.test(text)) text += '\n.intj/*/worktrees/\n'
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
function openWorkload(id?: string) {
  if (!id) {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    id = `${stamp}-${crypto.randomUUID()}`
  }
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.intj', id)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.md'), `# ${path.basename(projectDir)}\n`)
    // Commit the new doc so sessions' worktrees start with it, leaving anything the user staged alone.
    git(['add', '--', dir])
    git(['commit', '-m', `intj: 新建 workload ${id}`, '--', dir])
  }
  workloadDir = dir
  workloadRel = path.relative(git(['rev-parse', '--show-toplevel']).trim(), dir)
  watchDocs()
}

// ---- Agent terminals ----

type AgentTerm = {
  status: 'running' | 'exited'
  // Whether the agent is working on a turn, as opposed to waiting for input.
  busy: boolean
  term: IPty
  buffer: string
  clients: Set<WebSocket>
}
const MAX_BUFFER = 500_000
// Claude Code reports its state in the terminal title: a spinning glyph while working, ✳ when waiting.
const TITLE = /\x1b\]0;([^\x07]*)\x07/g

function spawnAgent(cwd: string, command: string, env: Record<string, string> = {}): AgentTerm {
  const term = pty.spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', command], {
    name: 'xterm-256color',
    cwd,
    cols: 100,
    rows: 30,
    env: { ...process.env, COLORTERM: 'truecolor', ...env },
  })
  const t: AgentTerm = { status: 'running', busy: true, term, buffer: '', clients: new Set() }
  // It titles itself ✳ while booting, before it picks up the first prompt; ignore that one.
  let working = false
  const setBusy = (busy: boolean) => {
    if (t.busy === busy) return
    t.busy = busy
    // Sessions extend this object, so an id means this terminal is a session's.
    const id = (t as Partial<Session>).id
    // An ended session's worktree is gone, so skip its late output.
    if (id) sessions.has(id) && broadcast({ type: 'activity', id, busy, unmerged: hasUnmerged(t as Session) })
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
    for (const ws of t.clients) ws.send('\r\n[进程已退出]\r\n')
    broadcastSessions()
  })
  return t
}

// The default terminal: a plain agent session on the main checkout, restarted if it has exited.
let mainTerm: AgentTerm | null = null
const getMainTerm = () => {
  if (mainTerm?.status !== 'running') mainTerm = spawnAgent(projectDir, agent)
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
}
type Anchor = Pick<Session, 'quote' | 'prefix' | 'suffix' | 'pos'>
const sessions = new Map<string, Session>()

// Whether the worktree has anything main doesn't: uncommitted edits or commits not merged yet.
const hasUnmerged = (s: Session) =>
  !!git(['status', '--porcelain'], s.worktree).trim() || git(['rev-list', '--count', `HEAD..${s.branch}`]).trim() !== '0'

const publicSession = (s: Session) => {
  const { id, doc, quote, prefix, suffix, pos, prompt, branch, status, busy } = s
  return { id, doc, quote, prefix, suffix, pos, prompt, branch, status, busy, unmerged: hasUnmerged(s) }
}
const broadcastSessions = () => broadcast({ type: 'sessions', list: [...sessions.values()].map(publicSession) })

// With a skill, the prompt becomes the skill's optional argument and leads the message,
// since the agent only recognizes a slash command at the start.
function startSession(doc: string, anchor: Anchor, prompt: string, skill?: string) {
  const { quote } = anchor
  const id = crypto.randomBytes(3).toString('hex')
  const branch = `intj/${id}`
  const worktree = path.join(workloadDir, 'worktrees', id)
  git(['worktree', 'add', '-b', branch, worktree])

  // Quote the selection as context only; naming the doc made agents think they should edit it.
  const quoted = quote ? quote.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : ''
  // Pass the prompt through the environment to avoid shell quoting issues.
  if (skill) prompt = `/intj:${skill} ${prompt}`.trim()
  const text = skill ? `${prompt}\n\n${quoted}` : quoted + prompt
  const t = spawnAgent(worktree, `${agent} "$INTJ_PROMPT"`, { INTJ_PROMPT: text })
  // Extend the same object: its pty callbacks update buffer and status in place.
  const s: Session = Object.assign(t, { id, doc, ...anchor, prompt, branch, worktree })
  sessions.set(id, s)
  broadcastSessions()
  return s
}

function mergeSession(s: Session) {
  git(['add', '-A'], s.worktree)
  if (git(['status', '--porcelain'], s.worktree).trim()) {
    git(['commit', '-m', `intj ${s.id}: ${s.prompt.split('\n')[0]}`], s.worktree)
  }
  try {
    git(['merge', '--no-edit', s.branch])
  } catch (e) {
    try {
      git(['merge', '--abort'])
    } catch {}
    throw e
  }
}

// When git can't merge on its own (usually a conflict), hand the job to the agent on the main
// checkout, following the merge skill, which resolves conflicts whose intent is clear.
function handOffMerge(s: Session) {
  const text = `/intj:merge-worktree ${s.branch}`
  if (mainTerm?.status === 'running') {
    mainTerm.term.write(text)
    // Send Enter separately so the TUI doesn't treat it as part of a paste.
    setTimeout(() => mainTerm?.term.write('\r'), 300)
  } else {
    mainTerm = spawnAgent(projectDir, `${agent} "$INTJ_PROMPT"`, { INTJ_PROMPT: text })
  }
}

function endSession(s: Session) {
  s.term.kill()
  for (const ws of s.clients) ws.close()
  git(['worktree', 'remove', '--force', s.worktree])
  git(['branch', '-D', s.branch])
  sessions.delete(s.id)
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
      return sendJson(res, 200, { workload: workloadDir && path.basename(workloadDir) })
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
      const workloads = openProject(dir)
      return sendJson(res, 200, { project: projectDir, workloads })
    }
    if (req.method === 'POST' && url === '/api/workload') {
      const { id } = await readBody(req)
      openWorkload(id)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url === '/api/doc') {
      return sendJson(res, 200, { text: readDoc(docFile(workloadDir, docName)) })
    }
    if (req.method === 'POST' && url === '/api/sessions') {
      const { doc, anchor, prompt, skill } = await readBody(req)
      return sendJson(res, 200, publicSession(startSession(doc, anchor, prompt, skill)))
    }
    if (req.method === 'GET' && url === '/api/tree') {
      // Tracked plus untracked-but-not-ignored files, so the tree follows .gitignore.
      const files = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean)
      return sendJson(res, 200, { files })
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
        endSession(s)
        return sendJson(res, 200, { ok: true })
      }
      try {
        mergeSession(s)
        broadcastSessions()
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        handOffMerge(s)
        return sendJson(res, 200, { ok: true, handedOff: true, error: errorText(e) })
      }
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
  // Run in the workload folder, git lists paths relative to it.
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard'], workloadDir).split('\n')
  for (const f of files) {
    if (!f.endsWith('.md') || f === name) continue
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
// Any doc can be open, so watch every md file in the workload outside its worktrees.
const watchDocs = () =>
  fs.watch(workloadDir, { recursive: true }, (_event, name) => {
    if (!name?.endsWith('.md') || name.startsWith('worktrees/')) return
    const text = readDoc(path.join(workloadDir, name))
    if (text === lastText.get(name)) return
    lastText.set(name, text)
    broadcast({ type: 'content', name, text })
  })

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
    if (s.status !== 'running') return
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
  console.log(`打开 http://localhost:${port}`)
})
