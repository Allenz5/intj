import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'
import pty, { type IPty } from 'node-pty'

const projectDir = path.resolve(process.argv[2] ?? process.cwd())
const docName = 'README.md'
const docPath = path.join(projectDir, docName)
// The agent is just a command run in a terminal, so any CLI agent can be swapped in.
const agent = process.env.INTJ_AGENT ?? 'claude'
const port = Number(process.env.PORT ?? 5173)
const worktreeRoot = path.join(projectDir, '.intj', 'worktrees')

const git = (args: string[], cwd = projectDir) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

// Keep worktrees out of the main repo's status without touching tracked files.
const excludeFile = path.resolve(projectDir, git(['rev-parse', '--git-dir']).trim(), 'info', 'exclude')
if (!fs.existsSync(excludeFile) || !fs.readFileSync(excludeFile, 'utf8').includes('.intj/')) {
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, '\n.intj/\n')
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
  quote: string
  prompt: string
  branch: string
  worktree: string
}
const sessions = new Map<string, Session>()

// Whether the worktree has anything main doesn't: uncommitted edits or commits not merged yet.
const hasUnmerged = (s: Session) =>
  !!git(['status', '--porcelain'], s.worktree).trim() || git(['rev-list', '--count', `HEAD..${s.branch}`]).trim() !== '0'

const publicSession = (s: Session) => {
  const { id, quote, prompt, branch, status, busy } = s
  return { id, quote, prompt, branch, status, busy, unmerged: hasUnmerged(s) }
}
const broadcastSessions = () => broadcast({ type: 'sessions', list: [...sessions.values()].map(publicSession) })

// With a skill, the prompt becomes the skill's optional argument and leads the message,
// since the agent only recognizes a slash command at the start.
function startSession(quote: string, prompt: string, skill?: string) {
  const id = crypto.randomBytes(3).toString('hex')
  const branch = `intj/${id}`
  const worktree = path.join(worktreeRoot, id)
  git(['worktree', 'add', '-b', branch, worktree])

  // Quote the selection as context only; naming the doc made agents think they should edit it.
  const quoted = quote ? quote.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : ''
  // Pass the prompt through the environment to avoid shell quoting issues.
  if (skill) prompt = `/intj:${skill} ${prompt}`.trim()
  const text = skill ? `${prompt}\n\n${quoted}` : quoted + prompt
  const t = spawnAgent(worktree, `${agent} "$INTJ_PROMPT"`, { INTJ_PROMPT: text })
  // Extend the same object: its pty callbacks update buffer and status in place.
  const s: Session = Object.assign(t, { id, quote, prompt, branch, worktree })
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
  const url = req.url ?? ''
  if (!url.startsWith('/api/')) return vite.middlewares(req, res)
  try {
    if (req.method === 'POST' && url === '/api/sessions') {
      const { quote, prompt, skill } = await readBody(req)
      return sendJson(res, 200, publicSession(startSession(quote, prompt, skill)))
    }
    if (req.method === 'GET' && url === '/api/tree') {
      // Tracked plus untracked-but-not-ignored files, so the tree follows .gitignore.
      const files = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean)
      return sendJson(res, 200, { files })
    }
    const d = url.match(/^\/api\/sessions\/(\w+)\/doc$/)
    const ds = d && sessions.get(d[1])
    if (req.method === 'GET' && ds) {
      // The worktree's current file, uncommitted edits included, since merge commits them.
      return sendJson(res, 200, { text: readDoc(path.join(ds.worktree, docName)) })
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

const readDoc = (file = docPath) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

let lastText = readDoc()
const eventClients = new Set<WebSocket>()
function broadcast(msg: unknown) {
  for (const ws of eventClients) ws.send(JSON.stringify(msg))
}

// Watch the directory, not the file: editors (and agents) often save by rename, which breaks a file watch.
fs.watch(projectDir, (_event, name) => {
  if (name !== docName) return
  const text = readDoc()
  if (text === lastText) return
  lastText = text
  broadcast({ type: 'content', text })
})

const eventsWss = new WebSocketServer({ noServer: true })
eventsWss.on('connection', (ws) => {
  eventClients.add(ws)
  ws.send(JSON.stringify({ type: 'content', name: docName, text: lastText }))
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
  console.log(`intj: ${projectDir}`)
  console.log(`打开 http://localhost:${port}`)
})
