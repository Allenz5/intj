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
// <project>/.opendoc/<date-time>-<uuid>: the workload's md docs, plus its sessions' worktrees.
let workloadDir = ''
// The workload's path from the repo root, which is also where its docs sit in each worktree.
let workloadRel = ''
// The agent is just a command run in a terminal, so any CLI agent can be swapped in.
// Mutable so the picker can set it before the main terminal starts.
let agentCmd = process.env.OPENDOC_AGENT ?? 'claude'
// Directories a session's worktree is cone-checked-out to; empty means a full checkout. Set from the
// picker (or OPENDOC_SPARSE) to speed up worktree creation on a huge repo.
const normDir = (d: string) => d.trim().replace(/\/+$/, '')
// Multiple dirs, separated by whitespace, commas, or colons; trailing slashes trimmed.
const parseCone = (s: string) => s.split(/[\s:,]+/).map(normDir).filter(Boolean)
let sparseCone = parseCone(process.env.OPENDOC_SPARSE ?? '')
// A workload's foundation worktree: a checkout on its own branch, derived from `base` (fetched first),
// that the main agent runs in and sessions branch from. Set from the picker when a workload is created;
// an empty branch means no worktree — the workload runs on the main checkout, as before.
let workloadBranch = ''
let workloadBase = ''
const port = Number(process.env.PORT ?? 5173)

// Git runs off the event loop: on a large repo a status/worktree call takes seconds, and a
// synchronous call would freeze the whole server (every request would hang) while it ran.
const execFileP = promisify(execFile)
const git = async (args: string[], cwd = projectDir, env = process.env) =>
  (await execFileP('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 })).stdout

// ---- Per-workload settings ----

// Each workload keeps its own agent command and sparse dirs in its settings.json (untracked, like the
// rest of .opendoc); a new workload copies the most recent one's (the picker seeds them). Applied to the
// live agentCmd/sparseCone when the workload is opened, since sessions run against the open workload.
type Settings = { agent: string; sparse: string[]; branch: string; base: string }
const settingsFile = (workloadDir: string) => path.join(workloadDir, 'settings.json')
function loadSettings(workloadDir: string): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(workloadDir), 'utf8'))
    return {
      agent: typeof s.agent === 'string' && s.agent.trim() ? s.agent : 'claude',
      sparse: Array.isArray(s.sparse) ? s.sparse.map(String).map(normDir).filter(Boolean) : [],
      branch: typeof s.branch === 'string' ? s.branch.trim() : '',
      base: typeof s.base === 'string' ? s.base.trim() : '',
    }
  } catch {
    return { agent: 'claude', sparse: [], branch: '', base: '' }
  }
}
function saveSettings() {
  if (!workloadDir) return
  fs.writeFileSync(
    settingsFile(workloadDir),
    JSON.stringify({ agent: agentCmd, sparse: sparseCone, branch: workloadBranch, base: workloadBase }, null, 2),
  )
}

// Check each sparse dir names a real directory in the repo at HEAD, so a session's worktree isn't
// cone-checked out to nothing. Returns the dirs that don't exist (empty if all are fine, or the repo
// has no commits yet — then there's nothing to check against). Paths are repo-root-relative, matching
// how `git sparse-checkout set` reads them.
async function invalidSparseDirs(dirs: string[]): Promise<string[]> {
  if (!dirs.length) return []
  try {
    await git(['rev-parse', '--verify', 'HEAD'])
  } catch {
    return []
  }
  const bad: string[] = []
  for (const d of dirs) {
    try {
      // HEAD:<path> is always repo-root-relative; a directory is a tree, a file a blob.
      if ((await git(['cat-file', '-t', `HEAD:${d}`])).trim() !== 'tree') bad.push(d)
    } catch {
      bad.push(d)
    }
  }
  return bad
}

// ---- Project and workload ----

const WORKLOAD = /^\d{8}-\d{4}-[0-9a-f-]{36}$/

// A workload's foundation worktree lives at `.opendoc/<id>/root`. When it exists it stands in for the
// main checkout: the main agent runs in it and sessions branch from it, so the real checkout is never
// touched. Workloads created without a branch (or before this) have none and fall back to the main
// checkout.
const rootDir = (dir = workloadDir) => path.join(dir, 'root')
const hasRoot = (dir = workloadDir) => !!dir && fs.existsSync(rootDir(dir))
// The active workload's foundation, and the same resolved from a session's own worktree path
// (`<workloadDir>/worktrees/<id>`) so per-session git ops stay correct even if the active tab changed.
const workloadRoot = () => (hasRoot() ? rootDir() : projectDir)
const sessionWl = (s: Pick<Session, 'worktree'>) => path.dirname(path.dirname(s.worktree))
const sessionRoot = (s: Pick<Session, 'worktree'>) => (hasRoot(sessionWl(s)) ? rootDir(sessionWl(s)) : projectDir)

// Build the open workload's foundation worktree on `branch`, derived from `base`. The base is always
// fetched from origin first so the worktree starts from the latest remote state, falling back to a local
// ref when there's no remote (or the fetch fails). An existing branch is reused as-is (base ignored). No
// branch means the workload stays on the main checkout.
async function createWorktree(branch: string, base: string) {
  if (!workloadDir || !branch || hasRoot()) return
  const dir = rootDir()
  const exists = await git(['rev-parse', '--verify', `refs/heads/${branch}`]).then(() => true, () => false)
  let startRef = branch
  if (!exists) {
    const head = base || (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const fetched = await git(['fetch', 'origin', head]).then(() => true, () => false)
    if (fetched) {
      startRef = `origin/${head}`
    } else {
      const ok = await git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]).then(() => true, () => false)
      if (!ok) throw new Error(`Base "${head}" not found locally and could not be fetched from origin`)
      startRef = head
    }
  }
  const born = exists ? [dir, branch] : ['-b', branch, dir, startRef]
  if (sparseCone.length) {
    await git(['worktree', 'add', '--no-checkout', ...born])
    await git(['sparse-checkout', 'init', '--cone', '--sparse-index'], dir)
    await git(['sparse-checkout', 'set', ...sparseCone], dir)
    await git(['checkout'], dir)
  } else {
    await git(['worktree', 'add', ...born])
  }
}

async function openProject(dir: string) {
  projectDir = fs.realpathSync(dir)
  try {
    await git(['rev-parse', '--git-dir'])
  } catch {
    await git(['init'])
  }
  // The whole .opendoc tree stays out of git: docs are never committed or pushed, and each session's
  // worktree gets them copied in. Doc changes are 3-way merged back with git merge-file, not git merge.
  const excludeFile = path.resolve(projectDir, (await git(['rev-parse', '--git-dir'])).trim(), 'info', 'exclude')
  let text = readDoc(excludeFile)
  if (!/^\.opendoc\/?$/m.test(text)) text += '\n.opendoc/\n'
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.writeFileSync(excludeFile, text)
  return listWorkloads()
}

// Newest first, each titled by its root doc's first heading, with its saved settings so the picker can
// show them and seed a new workload from the most recent.
function listWorkloads() {
  const root = path.join(projectDir, '.opendoc')
  const ids = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => WORKLOAD.test(n)).sort().reverse() : []
  return ids.map((id) => {
    const dir = path.join(root, id)
    const { agent, sparse, branch, base } = loadSettings(dir)
    return { id, title: readDoc(path.join(dir, 'main.md')).match(/^#\s+(.+)/m)?.[1] ?? '', agent, sparse, branch, base }
  })
}

// Open a workload, or create one when no id is given. Switching tabs leaves the previous workload's
// agents alive (see mains/sessions); only its session metadata is persisted here before we switch.
async function openWorkload(id?: string) {
  if (workloadDir) saveSessions()
  if (!id) {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    id = `${stamp}-${crypto.randomUUID()}`
  }
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.opendoc', id)
  const created = !fs.existsSync(dir)
  if (created) {
    // Docs are not tracked; a session's worktree gets them copied in, so no commit is needed.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.md'), `# ${path.basename(projectDir)}\n`)
  }
  workloadDir = dir
  workloadRel = path.relative((await git(['rev-parse', '--show-toplevel'])).trim(), dir)
  watchDocs()
  return created
}

// Delete a workload: end its sessions (dropping their worktrees/branches), then remove its folder.
async function deleteWorkload(id: string) {
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.opendoc', id)
  const m = mains.get(id)
  if (m) {
    m.term?.kill()
    mains.delete(id)
  }
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

// Close a workload's tab: stop its main agent and session agents, but leave everything on disk — its
// docs, worktrees, saved sessions, and the main agent's conversation id all persist, so reopening the
// tab restores the cards and resumes every agent. (Contrast deleteWorkload, which removes the folder.)
function closeWorkload(id: string) {
  if (!WORKLOAD.test(id)) throw new Error(`invalid workload: ${id}`)
  const dir = path.join(projectDir, '.opendoc', id)
  // Clear the active pointer first, so a terminal's exit doesn't persist an emptied session list.
  if (workloadDir === dir) {
    closeDocWatcher()
    workloadDir = ''
    workloadRel = ''
  }
  const m = mains.get(id)
  if (m) {
    m.term?.kill()
    for (const ws of m.clients) ws.close()
    mains.delete(id)
  }
  for (const s of [...sessions.values()]) {
    if (s.worktree.startsWith(dir + path.sep)) {
      s.term?.kill()
      for (const ws of s.clients) ws.close()
      sessions.delete(s.id)
      unmergedCache.delete(s.id)
    }
  }
  broadcast({ type: 'sessions', list: activeSessions().map(publicSession) })
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
  // Flips busy→idle once the agent's output has gone quiet (see noteActivity).
  idleTimer?: ReturnType<typeof setTimeout>
}
const MAX_BUFFER = 500_000
// Agents differ in how they resume/fork a conversation. isaac keeps its conversations in its own
// (local or cloud) session store rather than Claude Code's <id>.jsonl, so forking uses
// `isaac resume <id> --fork` instead of copying the transcript and passing --resume --fork-session.
const agentIsIsaac = () => /(^|\/)isaac$/.test(agentCmd.trim().split(/\s+/)[0] ?? '')
// Resuming a saved conversation: isaac uses a `resume <id>` subcommand, Claude Code a `--resume <id>` flag.
const resumeCmd = (chat: string) => (agentIsIsaac() ? `${agentCmd} resume ${chat}` : `${agentCmd} --resume ${chat}`)

// Agent status is inferred generically from terminal output, not agent-specific hooks: while an agent
// works it streams output, and while it waits for input the output goes quiet. So any output marks the
// terminal busy, and after this much silence it's marked idle again — this works for any CLI agent.
const IDLE_MS = 1200
function noteActivity(t: AgentTerm, id: string) {
  setBusy(id, true)
  clearTimeout(t.idleTimer)
  t.idleTimer = setTimeout(() => setBusy(id, false), IDLE_MS)
}

const newTerm = (): AgentTerm => ({ status: 'creating', busy: true, term: null, buffer: '', clients: new Set() })

// Start the pty for a term object; its callbacks update that same object in place, so a session
// created earlier (in the 'creating' state) simply gets its terminal filled in here.
function startTerm(t: AgentTerm, cwd: string, command: string, env: Record<string, string> = {}) {
  // Sessions extend this object, so an id means this terminal is a session's.
  const id = (t as Partial<Session>).id ?? 'main'
  // Drop the markers that say "you're a nested child of this Claude Code session". Otherwise, when the
  // opendoc server was itself launched from inside Claude Code/isaac, every agent inherits them, runs as
  // a child with transcript saving OFF, and its conversation is never saved — so it can't be resumed,
  // forked, or restored. Stripping them makes each agent an independent, saveable session. (Auth,
  // telemetry, and feature CLAUDE_CODE_* vars are left intact.)
  const {
    CLAUDECODE,
    CLAUDE_CODE_CHILD_SESSION,
    CLAUDE_CODE_SESSION_ID,
    CLAUDE_CODE_SESSION_ATTENDED,
    CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_CODE_MESSAGING_SOCKET,
    CLAUDE_CODE_MESSAGING_TOKEN,
    ...baseEnv
  } = process.env
  const term = pty.spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', command], {
    name: 'xterm-256color',
    cwd,
    cols: 100,
    rows: 30,
    env: { ...baseEnv, COLORTERM: 'truecolor', ...env },
  })
  t.term = term
  t.status = 'running'
  t.busy = true
  term.onData((data) => {
    // Keep recent output so a terminal opened later (or after a page reload) shows history.
    t.buffer = (t.buffer + data).slice(-MAX_BUFFER)
    for (const ws of t.clients) ws.send(data)
    // Output means the agent is working; quiet means it's idle (see noteActivity).
    noteActivity(t, id)
  })
  term.onExit(() => {
    t.status = 'exited'
    for (const ws of t.clients) ws.send('\r\n[process exited]\r\n')
    // A main term reports its own state; a session's exit changes the session list.
    if (id.startsWith('main:')) {
      if (id.slice(5) === activeWid()) broadcast({ type: 'main', busy: false, status: 'exited' })
    } else broadcastSessions()
  })
  return t
}

function setBusy(id: string, busy: boolean) {
  // A main term's id is `main:<workload>`, so its state only reaches the client while that workload is
  // the active tab (each workload keeps its own always-on main agent, but only one is shown at a time).
  if (id.startsWith('main:')) {
    const wid = id.slice(5)
    const m = mains.get(wid)
    if (!m || m.busy === busy) return
    m.busy = busy
    if (wid === activeWid()) {
      broadcast({ type: 'main', busy, status: m.status })
      // The main terminal may have just merged a handed-off session.
      if (!busy) broadcastSessions()
    }
    return
  }
  const t = sessions.get(id)
  // An ended session is gone, so its late output is ignored.
  if (!t || t.busy === busy) return
  t.busy = busy
  broadcast({ type: 'activity', id, busy, unmerged: unmergedCache.get(id) ?? false })
  // Recompute the merge state off the event loop rather than blocking on git here.
  refreshUnmerged(t as Session)
}

const spawnAgent = (cwd: string, command: string, env: Record<string, string> = {}) =>
  startTerm(newTerm(), cwd, command, env)

// Type `text` into a just-started terminal once its agent looks ready (output has arrived, then gone
// quiet). For agents that can't take the prompt as a launch argument, e.g. isaac's `resume --fork`.
function sendWhenReady(t: AgentTerm, text: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sub = t.term?.onData(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      sub?.dispose()
      t.term?.write(text)
      // Send Enter separately so the TUI doesn't treat it as part of a paste.
      setTimeout(() => t.term?.write('\r'), 300)
    }, 1500)
  })
}

// The always-on main agent: a plain agent session in the workload's foundation worktree, and the doc's persistent
// comment block. Each workload keeps its own, so switching tabs leaves the others' agents running; a
// closed tab's agent is killed but its conversation id is saved, so reopening resumes it. Keyed by
// workload id; the active workload's is the one the client's `main` terminal talks to.
type Main = AgentTerm & { chat: string }
const mains = new Map<string, Main>()
const activeWid = () => (workloadDir ? path.basename(workloadDir) : '')
// The conversation id persists next to the workload's docs (untracked), so a reopened workload resumes
// the same main-agent conversation rather than starting a fresh one.
const mainChatFile = (dir: string) => path.join(dir, 'main-chat')
const loadMainChat = (dir: string) => {
  try {
    return fs.readFileSync(mainChatFile(dir), 'utf8').trim()
  } catch {
    return ''
  }
}
const saveMainChat = (dir: string, chat: string) => {
  try {
    fs.writeFileSync(mainChatFile(dir), chat)
  } catch {}
}

function getMainTerm(): Main {
  const wid = activeWid()
  let m = mains.get(wid)
  if (m && m.status === 'running') return m
  // Resume a saved conversation if this workload has one; otherwise start a fresh one and prime it.
  const saved = m?.chat || loadMainChat(workloadDir)
  const chat = saved || crypto.randomUUID()
  m = Object.assign(m ?? newTerm(), { chat, id: `main:${wid}` }) as Main
  mains.set(wid, m)
  saveMainChat(workloadDir, chat)
  if (saved) {
    // The conversation already has the docs' context; just resume it.
    startTerm(m, workloadRoot(), resumeCmd(chat))
    m.busy = false
  } else {
    // Prime the main agent with the open workload's docs so it starts with the same context, without
    // producing a reply, and tell it to keep those docs current. Passed through the environment to
    // avoid shell-quoting issues.
    const md = workloadDir && path.join(workloadDir, 'main.md')
    const prompt = md
      ? `This project's working docs live in the .opendoc workload directory ${workloadDir}; its root doc is ${md}. ` +
        `Read ${md} and the docs it links to for context — just read them for now, don't reply. ` +
        `As we work, when changes should be reflected in the docs, use the opendoc:update-docs skill to update the docs in ${workloadDir}.`
      : ''
    const arg = prompt ? ' "$OPENDOC_PROMPT"' : ''
    startTerm(m, workloadRoot(), `${agentCmd} --session-id ${chat}${arg}`, prompt ? { OPENDOC_PROMPT: prompt } : {})
  }
  return m
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendoc-merge-'))
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
    // docBase advanced for the synced sessions; keep the persisted merge bases current.
    saveSessions()
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

// Whether the worktree has anything the workload's foundation doesn't (uncommitted edits or unmerged commits), cached so
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
        const ahead = (await git(['rev-list', '--count', `HEAD..${s.branch}`], sessionRoot(s))).trim() !== '0'
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
// Only the active workload's sessions are shown/broadcast; the others' agents stay alive in the map
// but belong to background tabs.
const activeSessions = () => [...sessions.values()].filter((s) => !!workloadDir && s.worktree.startsWith(workloadDir + path.sep))
const broadcastSessions = () => {
  saveSessions()
  broadcast({ type: 'sessions', list: activeSessions().map(publicSession) })
}

// ---- Restoring sessions ----

// A workload remembers its live sessions, so reopening it brings their cards and agents back. The
// worktree, branch, and the agent's conversation all persist on disk already; this only records the
// light metadata (ids, anchors, merge bases) needed to rebuild each Session. Saved (untracked) next to
// the workload's docs, only for sessions of the currently open workload.
const sessionsFile = () => path.join(workloadDir, 'sessions.json')
function saveSessions() {
  if (!workloadDir) return
  const mine = [...sessions.values()].filter((s) => s.worktree.startsWith(workloadDir + path.sep))
  try {
    const data = mine.map(({ id, doc, quote, prefix, suffix, pos, prompt, branch, worktree, chat, docBase }) => ({
      id, doc, quote, prefix, suffix, pos, prompt, branch, worktree, chat, docBase,
    }))
    fs.writeFileSync(sessionsFile(), JSON.stringify(data, null, 2))
  } catch {}
}

// Rebuild the open workload's saved sessions, resuming each agent's conversation in its worktree.
function restoreSessions() {
  let saved: any[]
  try {
    saved = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'))
  } catch {
    return
  }
  if (!Array.isArray(saved)) return
  for (const r of saved) {
    if (!r?.id || sessions.has(r.id)) continue
    const worktree = path.join(workloadDir, 'worktrees', r.id)
    // Skip any whose worktree is gone (ended elsewhere, pruned); the save below then drops them.
    if (!fs.existsSync(worktree)) continue
    const s: Session = Object.assign(newTerm(), {
      id: r.id,
      doc: r.doc ?? 'main.md',
      quote: r.quote ?? '',
      prefix: r.prefix ?? '',
      suffix: r.suffix ?? '',
      pos: r.pos ?? 0,
      prompt: r.prompt ?? '',
      branch: r.branch ?? `opendoc/${r.id}`,
      worktree,
      chat: r.chat ?? '',
      docBase: r.docBase ?? {},
    })
    sessions.set(r.id, s)
    if (s.chat) {
      // The conversation's jsonl still sits in this worktree's project dir, so resuming finds it.
      startTerm(s, worktree, resumeCmd(s.chat))
      // Resuming isn't a turn — the agent waits for input.
      s.busy = false
    } else {
      s.status = 'exited'
    }
    refreshUnmerged(s)
  }
  broadcastSessions()
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
function startSession(doc: string, anchor: Anchor, prompt: string, skill?: string, from?: Pick<Session, 'id' | 'worktree' | 'chat'>) {
  const { quote } = anchor
  const id = crypto.randomBytes(3).toString('hex')
  const branch = `opendoc/${id}`
  const worktree = path.join(workloadDir, 'worktrees', id)
  const chat = crypto.randomUUID()
  // For a skill the message leads with the slash command; this is also what the card shows.
  const cmd = skill ? `/opendoc:${skill} ${prompt}`.trim() : prompt
  const s: Session = Object.assign(newTerm(), { id, doc, ...anchor, prompt: cmd, branch, worktree, chat, docBase: {} })
  sessions.set(id, s)
  broadcastSessions()

  ;(async () => {
    try {
      // Branch from the committed HEAD of the source worktree — the workload's foundation for a new
      // session, or the source session's worktree for a fork. Uncommitted work does not carry over, so
      // the agent must commit for its work to flow down to sessions derived from it.
      const srcWorktree = from ? from.worktree : workloadRoot()
      const startPoint = (await git(['rev-parse', 'HEAD'], srcWorktree)).trim()
      // Materializing a huge repo's whole tree is the bottleneck. When OPENDOC_SPARSE names directories,
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
        `When done, use the opendoc:update-docs skill to update the markdown docs in ${path.dirname(file)}.`
      let text = skill ? `${cmd}\n\n${context}` : context
      // The forked conversation names the old worktree's paths, so point the agent at its own copy.
      if (from) text = `(Forked: you now work in ${worktree}, a copy of ${from.worktree}. Edit files here only.)\n\n${text}`
      if (from && agentIsIsaac()) {
        // isaac resolves the source by id (local or cloud) and branches it with `resume --fork`; the
        // prompt can't be a launch argument, so type it in once the resumed session is ready. Status
        // is tracked generically from output (noteActivity), so this path needs no special handling.
        startTerm(s, worktree, `${agentCmd} resume ${from.chat} --fork`)
        sendWhenReady(s, text)
      } else {
        if (from) copyChat(from.chat, worktree)
        const resume = from ? `--resume ${from.chat} --fork-session ` : ''
        // Pass the prompt through the environment to avoid shell quoting issues.
        startTerm(s, worktree, `${agentCmd} ${resume}--session-id ${chat} "$OPENDOC_PROMPT"`, { OPENDOC_PROMPT: text })
      }
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

// Conflicts are resolved in the session's worktree, never on the foundation branch: docs get markers in
// the session's copy, and when the code won't merge cleanly the foundation branch is merged into the
// session's branch instead. The session's agent resolves both; the next Merge is then clean.
async function mergeSession(s: Session) {
  if (s.status === 'creating' || (s.status === 'running' && s.busy)) throw new Error('The session is still working; Merge once it is done')
  if (await midMerge(s.worktree)) throw new Error('The worktree is still resolving merge conflicts; Merge again once they are committed')
  // Merge docs first (outside git) so they land even if the code conflicts.
  const docConflicts = await mergeDocs(s)
  // Merge the code via git; docs are ignored, so only real code is committed and merged.
  await git(['add', '-A'], s.worktree)
  if ((await git(['status', '--porcelain'], s.worktree)).trim()) {
    await git(['commit', '-m', `opendoc ${s.id}: ${s.prompt.split('\n')[0]}`], s.worktree)
  }
  // Merge the session into the workload's foundation worktree (its branch), never the main checkout.
  const root = sessionRoot(s)
  let codeConflict = false
  try {
    await git(['merge', '--no-edit', s.branch], root)
  } catch (e) {
    try {
      await git(['merge', '--abort'], root)
    } catch {}
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim()
    const target = current === 'HEAD' ? (await git(['rev-parse', 'HEAD'], root)).trim() : current
    try {
      await git(['merge', '--no-edit', target], s.worktree)
    } catch (e2) {
      // Anything other than a conflict (which leaves the merge in progress) is a real error.
      if (!(await midMerge(s.worktree))) throw e2
      codeConflict = true
    }
    // The session now contains the foundation branch, so this merge is a fast-forward; if it still fails,
    // the cause wasn't a conflict (a dirty checkout, say), so report it.
    if (!codeConflict) await git(['merge', '--no-edit', s.branch], root)
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
  const text = docs.length ? `/opendoc:merge-doc ${files}${code ? ` — then: ${codeText}` : ''}` : codeText
  if (s.status === 'running') {
    s.term!.write(text)
    // Send Enter separately so the TUI doesn't treat it as part of a paste.
    setTimeout(() => s.term?.write('\r'), 300)
  } else {
    startTerm(s, s.worktree, `${agentCmd} --resume ${s.chat} "$OPENDOC_PROMPT"`, { OPENDOC_PROMPT: text })
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
      const { id, agent, sparse, branch, base } = await readBody(req)
      // No project open (e.g. the server was restarted while the browser kept the picker open): bail
      // clearly instead of running git — and thus the sparse-dir check — against the wrong directory.
      if (!projectDir) return sendJson(res, 409, { error: 'no project open' })
      // The agent command and sparse dirs come from the picker (the config it shows for this workload,
      // seeded from the most recent one for a new workload). Reject sparse dirs that don't exist in the
      // repo before opening, so a session's worktree isn't cone-checked out to nothing.
      const cone =
        sparse === undefined ? undefined : Array.isArray(sparse) ? sparse.map(String).map(normDir).filter(Boolean) : parseCone(String(sparse))
      if (cone) {
        const bad = await invalidSparseDirs(cone)
        if (bad.length)
          return sendJson(res, 400, { error: `Sparse ${bad.length > 1 ? 'directories' : 'directory'} not found in the repo: ${bad.join(', ')}` })
      }
      const created = await openWorkload(id)
      // Apply the picker's values to this workload and persist them; fall back to its saved settings
      // when the picker sent none (e.g. reopening straight from a link). Branch/base only define a new
      // workload's foundation worktree, so they come from its saved settings for an existing one.
      const saved = loadSettings(workloadDir)
      agentCmd = typeof agent === 'string' ? agent.trim() || 'claude' : saved.agent
      sparseCone = cone ?? saved.sparse
      workloadBranch = created && typeof branch === 'string' ? branch.trim() : saved.branch
      workloadBase = created && typeof base === 'string' ? base.trim() : saved.base
      saveSettings()
      // A new workload with a branch gets its own foundation worktree, derived from the fetched base.
      // If it can't be built, surface the error and stop — the user asked for a specific base to work
      // from, so silently falling back to the main checkout would be misleading.
      if (created && workloadBranch) {
        try {
          await createWorktree(workloadBranch, workloadBase)
        } catch (e) {
          await deleteWorkload(activeWid())
          return sendJson(res, 400, { error: `Could not create worktree: ${errorText(e)}` })
        }
      }
      // Bring back any sessions this workload had open (agentCmd is now set, so they resume correctly).
      restoreSessions()
      // Always refresh the client with this workload's cards (restoreSessions is silent when a workload
      // has none) and its main-agent state (its terminal spawns lazily, so report idle until then).
      broadcast({ type: 'sessions', list: activeSessions().map(publicSession) })
      const am = mains.get(activeWid())
      broadcast({ type: 'main', busy: am?.busy ?? false, status: am?.status ?? 'idle' })
      return sendJson(res, 200, { ok: true, id: activeWid() })
    }
    if (req.method === 'GET' && url === '/api/workloads') {
      return sendJson(res, 200, { workloads: projectDir ? listWorkloads() : [], active: activeWid(), project: projectDir })
    }
    if (req.method === 'POST' && url === '/api/workload/close') {
      const { id } = await readBody(req)
      closeWorkload(id)
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
    if (req.method === 'POST' && url === '/api/doc') {
      // Save an edit to the workload's doc, then broadcast it and sync it into live sessions (the
      // directory watcher is non-recursive, so do this explicitly rather than rely on it).
      const { text } = await readBody(req)
      const body = String(text ?? '')
      const file = docFile(workloadDir, docName)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      lastText.set(docName, body) // pre-empt the watcher's duplicate broadcast
      broadcast({ type: 'content', name: docName, text: body })
      syncAllDocs()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url === '/api/file') {
      // A doc's relative link to a repo file (e.g. a source file it references): serve it read-only so
      // clicking it shows the file, instead of the browser navigating same-origin and the SPA server
      // reloading the opendoc app. Resolved relative to the doc and confined to the repo.
      const doc = searchParams.get('doc') ?? ''
      const href = (searchParams.get('href') ?? '').split('#')[0]
      const repoRoot = (await git(['rev-parse', '--show-toplevel'])).trim()
      const target = path.resolve(path.dirname(path.resolve(workloadDir, doc)), href)
      if (target !== repoRoot && !target.startsWith(repoRoot + path.sep)) return sendJson(res, 400, { error: 'outside the repo' })
      try {
        const data = fs.readFileSync(target)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(data)
      } catch {
        return sendJson(res, 404, { error: `not found: ${href}` })
      }
    }
    if (req.method === 'POST' && url === '/api/sessions') {
      const { doc, anchor, prompt, skill, from } = await readBody(req)
      let src: Pick<Session, 'id' | 'worktree' | 'chat'> | undefined
      if (from === 'main') {
        // Fork from the active workload's main agent: its checkout and conversation are the source.
        const chat = mains.get(activeWid())?.chat
        if (!chat) return sendJson(res, 400, { error: 'Open the main agent and send it a message before forking from it' })
        src = { id: 'main', worktree: workloadRoot(), chat }
      } else if (from) {
        src = sessions.get(from)
        if (!src) return sendJson(res, 404, { error: `no session ${from}` })
      }
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
  const am = mains.get(activeWid())
  ws.send(JSON.stringify({ type: 'sessions', list: activeSessions().map(publicSession) }))
  ws.send(JSON.stringify({ type: 'main', busy: am?.busy ?? false, status: am?.status ?? 'idle' }))
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
