import { marked } from 'marked'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// Where a comment sits: its quote plus the text around it (whitespace removed) and its relative position.
type Anchor = { quote: string; prefix: string; suffix: string; pos: number }
type Session = Anchor & { id: string; doc: string; prompt: string; branch: string; status: 'creating' | 'running' | 'exited'; busy: boolean; unmerged: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const wsUrl = (p: string) => `ws://${location.host}${p}`

const DEFAULT_DOC = 'main.md'
let docName = ''
let docText = ''
let sessions: Session[] = []
// Whether the always-on main agent is working, for its card's state.
let mainBusy = false
// Id of the session whose worktree doc is shown while its Merge button is hovered.
let previewing: string | null = null
// Whether the doc is being edited as raw markdown, and the current doc's parent (for the Back button).
let editing = false
let docParent: string | null = null

// ---- Workload tabs ----
// Open tabs are the workloads shown in the top bar (persisted per project in localStorage). Only the
// active one is live on the client; switching keeps the others' agents running on the server, and
// closing a tab stops its agents — they resume from their saved ids when the tab is reopened.
let openTabs: string[] = []
let activeWorkload = ''
let allWorkloads: WorkloadInfo[] = []
let clientProject = ''
let pickerMode: 'start' | 'add' = 'start'
let eventsWs: WebSocket | null = null

// ---- Document ----

const onEvent = (e: MessageEvent) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'content') {
    if (msg.name !== docName) return
    docText = msg.text
    // Don't disturb an in-progress edit; the editor keeps the user's text until they save or cancel.
    if (editing) return
    // A merge while hovering changes the main doc, so re-diff against it.
    const s = sessions.find((x) => x.id === previewing)
    if (s) showWorktreeDoc(s)
    else showMainDoc()
  } else if (msg.type === 'sessions') {
    sessions = msg.list
    renderCards()
  } else if (msg.type === 'activity') {
    // Update in place: re-rendering the cards would cut off a Merge hover preview.
    const s = sessions.find((x) => x.id === msg.id)
    const card = document.querySelector<HTMLElement>(`.card[data-id="${msg.id}"]`)
    if (s && card) {
      s.busy = msg.busy
      s.unmerged = msg.unmerged
      renderState(card, s)
    }
    // The pty starts at a default size; once it's live, fit it to its pane.
    const t = activeId && terms.get(activeId)
    if (t) sendResize(t)
  } else if (msg.type === 'main') {
    mainBusy = msg.busy
    const card = document.querySelector<HTMLElement>('.card[data-id="main"]')
    if (card) renderMainState(card)
  } else if (msg.type === 'session-error') {
    alert(msg.error)
  }
}

async function openDoc(name: string) {
  if (editing) setEditing(false)
  docName = name
  const { text } = await (await fetch(`/api/doc?name=${encodeURIComponent(name)}`)).json()
  // Another link may have been clicked while fetching.
  if (docName !== name) return
  $('doc-name').textContent = name
  docText = text
  showMainDoc()
  renderCards()
  const { parent } = await (await fetch(`/api/parent?name=${encodeURIComponent(name)}`)).json()
  if (docName !== name) return
  docParent = parent
  $('doc-up').hidden = !parent || editing
  $('doc-up').title = parent ?? ''
  $('doc-up').onclick = () => goToDoc(parent)
}

// ---- Editing the raw markdown ----

const docEditor = $<HTMLTextAreaElement>('doc-editor')
function setEditing(on: boolean) {
  editing = on
  if (on) docEditor.value = docText
  docEditor.hidden = !on
  $('doc-body').hidden = on
  $('doc-edit').hidden = on
  $('doc-save').hidden = !on
  $('doc-cancel').hidden = !on
  $('doc-up').hidden = on || !docParent
  if (on) docEditor.focus()
  else showMainDoc() // re-render from docText
}
async function saveDoc() {
  const text = docEditor.value
  const res = await fetch(`/api/doc?name=${encodeURIComponent(docName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  docText = text
  setEditing(false)
}
$('doc-edit').onclick = () => setEditing(true)
$('doc-cancel').onclick = () => setEditing(false)
$('doc-save').onclick = saveDoc
// Cmd/Ctrl+S saves while editing.
docEditor.onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    saveDoc()
  }
}
function goToDoc(name: string) {
  history.pushState(null, '', `?doc=${encodeURIComponent(name)}`)
  openDoc(name)
}
const docFromUrl = () => new URLSearchParams(location.search).get('doc') ?? DEFAULT_DOC
window.onpopstate = () => openDoc(docFromUrl())

// Route link clicks so opendoc is never reloaded in place:
//  - an in-page anchor is left to the browser;
//  - a relative link to a sibling .md doc opens that doc here;
//  - an external URL opens in a new tab;
//  - any other relative link (a repo source file the doc references) opens read-only in a new tab,
//    rather than the browser navigating same-origin and the SPA server serving the opendoc app again.
$('preview').addEventListener('click', (e) => {
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
  if (!href || href.startsWith('#')) return
  if (/^[a-z]+:/i.test(href)) {
    e.preventDefault()
    window.open(href, '_blank', 'noopener')
    return
  }
  e.preventDefault()
  const file = href.split('#')[0]
  if (file.endsWith('.md')) {
    goToDoc(decodeURIComponent(new URL(file, `http://x/${docName}`).pathname.slice(1)))
  } else {
    window.open(`/api/file?doc=${encodeURIComponent(docName)}&href=${encodeURIComponent(href)}`, '_blank', 'noopener')
  }
})

function showMainDoc() {
  $('preview').innerHTML = marked.parse(docText) as string
  layoutCards()
}

// Show a session's worktree doc, marking blocks whose text isn't in the main doc.
async function showWorktreeDoc(s: Session) {
  previewing = s.id
  const { text } = await (await fetch(`/api/sessions/${s.id}/doc?name=${encodeURIComponent(docName)}`)).json()
  // The pointer may have left (or moved to another card) while fetching.
  if (previewing !== s.id) return
  const main = document.createElement('div')
  main.innerHTML = marked.parse(docText) as string
  const known = new Set([...main.querySelectorAll(BLOCKS)].map(ownText))
  const preview = $('preview')
  preview.innerHTML = marked.parse(text) as string
  for (const el of preview.querySelectorAll(BLOCKS)) el.classList.toggle('diff', !known.has(ownText(el)))
}

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th'
// A list item's text without its nested lists, so a change deep in a list marks only that item.
function ownText(el: Element) {
  const c = el.cloneNode(true) as Element
  c.querySelectorAll('ul, ol').forEach((x) => x.remove())
  return c.textContent!.trim()
}

// ---- Anchoring a quote in the rendered preview ----

// Work on text with whitespace removed, since a selection's text and the DOM's text nodes differ in line breaks.
type Flat = { chars: { node: Text; offset: number }[]; flat: string }
function flatten(root: HTMLElement): Flat {
  const chars: Flat['chars'] = []
  let flat = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.data.length; i++) {
      if (/\s/.test(n.data[i])) continue
      chars.push({ node: n, offset: i })
      flat += n.data[i]
    }
  }
  return { chars, flat }
}

// A range over flat characters [start, end), collapsed at start when empty.
function toRange(f: Flat, start: number, end: number) {
  const range = document.createRange()
  const c = f.chars[Math.min(start, f.chars.length - 1)]
  range.setStart(c.node, c.offset + (start >= f.chars.length ? 1 : 0))
  if (end > start) {
    const e = f.chars[end - 1]
    range.setEnd(e.node, e.offset + 1)
  } else range.collapse(true)
  return range
}

const CONTEXT = 30
function anchorOf(root: HTMLElement, range: Range, quote: string): Anchor {
  const f = flatten(root)
  const inside = f.chars.flatMap((c, i) =>
    range.comparePoint(c.node, c.offset) === 0 && range.comparePoint(c.node, c.offset + 1) === 0 ? [i] : [],
  )
  const start = inside[0] ?? 0
  const end = (inside.at(-1) ?? -1) + 1
  return {
    quote,
    prefix: f.flat.slice(Math.max(0, start - CONTEXT), start),
    suffix: f.flat.slice(end, end + CONTEXT),
    pos: f.flat.length ? start / f.flat.length : 0,
  }
}

// How many characters of ctx match flat, walking from `at` in direction dir.
function agree(flat: string, at: number, ctx: string, dir: 1 | -1) {
  let n = 0
  while (n < ctx.length && flat[at + dir * n] === ctx[dir > 0 ? n : ctx.length - 1 - n]) n++
  return n
}

// Find the quote again, taking the occurrence whose surroundings match best. If the quote itself
// was edited (usually by a merge), take what now sits between its old surroundings, then its old position.
function locate(f: Flat, a: Anchor): { range: Range; exact: boolean } {
  const q = a.quote.replace(/\s+/g, '')
  let best = -1
  let bestScore = -1
  for (let i = q ? f.flat.indexOf(q) : -1; i >= 0; i = f.flat.indexOf(q, i + 1)) {
    const score = agree(f.flat, i - 1, a.prefix, -1) + agree(f.flat, i + q.length, a.suffix, 1)
    if (score > bestScore) [best, bestScore] = [i, score]
  }
  if (best >= 0) return { range: toRange(f, best, best + q.length), exact: true }
  const p = f.flat.indexOf(a.prefix)
  const start = p < 0 ? -1 : p + a.prefix.length
  const end = a.suffix ? f.flat.indexOf(a.suffix, Math.max(start, 0)) : f.flat.length
  if (start >= 0 && end >= start) return { range: toRange(f, start, end), exact: false }
  const at = start >= 0 ? start : end >= 0 ? end : Math.round(a.pos * f.flat.length)
  return { range: toRange(f, at, at), exact: false }
}

// ---- Comment cards ----

const cardErrors = new Map<string, string>()

function renderCards() {
  // Replacing the Merge button under the pointer never fires its mouseleave.
  if (previewing) {
    previewing = null
    showMainDoc()
  }
  const gutter = $('gutter')
  gutter.innerHTML = ''
  // The main agent's card is always shown, on every doc; it has no worktree to merge or end.
  gutter.append(mainCard())
  for (const s of sessions) {
    if (s.doc !== docName) continue
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.id = s.id
    card.innerHTML = `
      <div class="card-quote"></div>
      <div class="card-prompt"></div>
      <div class="card-meta"><span class="card-state"></span><code>${s.branch}</code></div>
      <div class="card-actions">
        <button data-act="open">Open terminal</button>
        <button data-act="merge">Merge</button>
        <button data-act="end">End</button>
      </div>
      <div class="card-error" hidden></div>`
    card.querySelector('.card-quote')!.textContent = s.quote
    card.querySelector('.card-prompt')!.textContent = s.prompt
    renderState(card, s)
    const err = cardErrors.get(s.id)
    if (err) showCardError(card, err)
    const merge = card.querySelector<HTMLElement>('[data-act="merge"]')!
    merge.onmouseenter = () => showWorktreeDoc(s)
    merge.onmouseleave = () => {
      previewing = null
      showMainDoc()
    }
    card.onclick = (e) => {
      if (forking) return forkFrom(s)
      const act = (e.target as HTMLElement).dataset.act
      if (act === 'open') openTerminal(s)
      else if (act === 'merge' || act === 'end') runAction(s, act, card)
    }
    gutter.append(card)
  }
  layoutCards()
}

// The main agent's card: open its terminal or fork from it, but nothing to merge or end.
function mainCard() {
  const card = document.createElement('div')
  card.className = 'card card-main'
  card.dataset.id = 'main'
  card.innerHTML = `
    <div class="card-prompt">Main agent</div>
    <div class="card-meta"><span class="card-state"></span><code>main</code></div>
    <div class="card-actions"><button data-act="open">Open terminal</button></div>`
  renderMainState(card)
  card.onclick = (e) => {
    if (forking) return forkFrom({ id: 'main' } as Session)
    if ((e.target as HTMLElement).dataset.act === 'open') openTerminal(mainTerm)
  }
  return card
}

function renderMainState(card: HTMLElement) {
  const el = card.querySelector<HTMLElement>('.card-state')!
  el.className = `card-state ${mainBusy ? 'busy' : 'done'}`
  el.textContent = mainBusy ? 'Working' : 'Ready'
}

function renderState(card: HTMLElement, s: Session) {
  const state = s.status === 'creating' ? 'creating' : s.status === 'exited' ? 'exited' : s.busy ? 'busy' : 'done'
  const el = card.querySelector<HTMLElement>('.card-state')!
  el.className = `card-state ${state}`
  el.textContent = { creating: 'Creating worktree…', busy: 'Working', done: 'Done', exited: 'Exited' }[state]
  // Merge only shows while the worktree has something main doesn't, and can't be clicked mid-turn.
  const merge = card.querySelector<HTMLButtonElement>('[data-act="merge"]')!
  merge.hidden = !s.unmerged
  merge.disabled = state !== 'done' && state !== 'exited'
  // A button hidden or disabled under the pointer never fires its mouseleave.
  if ((merge.hidden || merge.disabled) && previewing === s.id) {
    previewing = null
    showMainDoc()
  }
}

function showCardError(card: HTMLElement, text: string) {
  const el = card.querySelector<HTMLElement>('.card-error')!
  el.textContent = text
  el.hidden = !text
}

async function runAction(s: Session, act: 'merge' | 'end', card: HTMLElement) {
  card.classList.add('busy')
  const res = await fetch(`/api/sessions/${s.id}/${act}`, { method: 'POST' })
  card.classList.remove('busy')
  const data = await res.json()
  cardErrors.set(s.id, res.ok ? '' : data.error)
  const ok = res.ok && !data.handedOff
  const base = data.handedOff
    ? "Conflicts handed to this session's agent to resolve in its worktree; Merge again once it's done"
    : ok
      ? act === 'merge'
        ? 'Merged'
        : ''
      : data.error
  // Docs merge outside git; note any that conflicted.
  const conflicts = data.docConflicts?.length ? `${base ? '; ' : ''}文档冲突: ${data.docConflicts.join(', ')}` : ''
  showCardError(card, base + conflicts)
  card.querySelector('.card-error')!.classList.toggle('ok', ok && !data.docConflicts?.length)
  if (data.handedOff) openTerminal(s)
  if (ok && act === 'end') closeTerminal(s.id)
}

// Place each card level with its quote, pushing down any that would overlap.
function layoutCards() {
  const preview = $('preview')
  const gutter = $('gutter')
  const base = gutter.getBoundingClientRect().top
  const ranges: Range[] = []
  let floor = 0
  const f = flatten(preview)
  const cards = [...gutter.querySelectorAll<HTMLElement>('.card')]
  const placed = cards.map((card) => {
    // The main card isn't a session and isn't anchored to a quote — pin it at the top.
    const s = sessions.find((x) => x.id === card.dataset.id)
    const hit = s && f.chars.length ? locate(f, s) : null
    if (hit && !hit.range.collapsed) ranges.push(hit.range)
    if (s) card.classList.toggle('orphan', !hit?.exact)
    return { card, top: s ? (hit ? hit.range.getBoundingClientRect().top - base : Infinity) : -Infinity }
  })
  placed.sort((a, b) => a.top - b.top)
  for (const p of placed) {
    const top = Math.max(p.top === Infinity ? floor : p.top, floor)
    p.card.style.top = `${top}px`
    floor = top + p.card.offsetHeight + 8
  }
  gutter.style.minHeight = `${floor}px`
  // Fork needs a card on this doc to pick.
  $<HTMLButtonElement>('popup-fork').disabled = !cards.length
  CSS.highlights?.set('opendoc-quote', new Highlight(...ranges))
}
window.addEventListener('resize', layoutCards)

// ---- Selection popup ----

let pendingAnchor: Anchor = { quote: '', prefix: '', suffix: '', pos: 0 }
const popup = $('popup')
const popupInput = $<HTMLInputElement>('popup-input')

function showPopup(quote: string, range: Range | null, x: number, y: number) {
  pendingAnchor = range ? anchorOf($('preview'), range, quote) : { quote, prefix: '', suffix: '', pos: 0 }
  // Focusing the input clears the selection, so keep it visible as a highlight.
  if (range) CSS.highlights?.set('opendoc-pending', new Highlight(range))
  popup.style.left = `${Math.min(x, window.innerWidth - 420)}px`
  popup.style.top = `${y + 6}px`
  popup.hidden = false
  popupInput.value = ''
  popupInput.focus()
}

$('preview').addEventListener('mouseup', (e) => {
  // Ctrl-click is a right-click on macOS.
  if (e.button !== 0 || e.ctrlKey) return
  const sel = getSelection()
  const text = sel?.toString().trim() ?? ''
  if (!sel || !text) return
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  showPopup(text, range.cloneRange(), rect.left, rect.bottom)
})

// On macOS a right-click first selects the word under the cursor, so keep the selection from before it.
let selBeforeRightClick: Range | null = null
$('preview').addEventListener('mousedown', (e) => {
  if (e.button !== 2 && !e.ctrlKey) return
  const sel = getSelection()
  selBeforeRightClick = sel && sel.toString().trim() ? sel.getRangeAt(0).cloneRange() : null
})

// Right-click opens a session on the selection, or else on the block under the cursor.
$('preview').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  getSelection()?.removeAllRanges()
  const saved = selBeforeRightClick
  if (saved) return showPopup(saved.toString().trim(), saved, e.clientX, e.clientY)
  const block = (e.target as HTMLElement).closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th')
  const quote = block?.textContent?.trim() ?? ''
  let range: Range | null = null
  if (block && quote) {
    range = document.createRange()
    range.selectNodeContents(block)
  }
  showPopup(quote, range, e.clientX, e.clientY)
})

function hidePopup() {
  popup.hidden = true
  CSS.highlights?.delete('opendoc-pending')
}
document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target as Node)) hidePopup()
  // Picking a card to fork from: a click anywhere else cancels.
  if (forking && !(e.target as HTMLElement).closest('.card')) stopForking()
})

// A skill makes the input optional: it becomes extra conditions for the skill.
async function startChat(skill?: string, from?: string, anchor = pendingAnchor, prompt = popupInput.value.trim()) {
  if (!prompt && !skill) return popupInput.focus()
  hidePopup()
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc: docName, anchor, prompt, skill, from }),
  })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  openTerminal(data)
}
$('popup-start').onclick = () => startChat()
$('popup-split').onclick = () => startChat('split-doc')
// Copy the selected text: the popup steals focus from the document (to type a comment), which clears
// the browser selection, so Cmd/Ctrl+C wouldn't copy it — copy the captured quote instead.
const copyQuote = () => {
  if (pendingAnchor.quote) navigator.clipboard?.writeText(pendingAnchor.quote).catch(() => {})
  hidePopup()
}
$('popup-copy').onclick = copyQuote
popupInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) startChat()
  if (e.key === 'Escape') hidePopup()
  // Copy the selection unless the user has selected text within the input itself.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && popupInput.selectionStart === popupInput.selectionEnd) {
    e.preventDefault()
    copyQuote()
  }
}

// Fork chat: keep the selection and prompt, then wait for a card to be clicked.
let forking: { anchor: Anchor; prompt: string } | null = null
$('popup-fork').onclick = () => {
  const prompt = popupInput.value.trim()
  if (!prompt) return popupInput.focus()
  forking = { anchor: pendingAnchor, prompt }
  popup.hidden = true
  document.body.classList.add('forking')
}
function stopForking() {
  forking = null
  document.body.classList.remove('forking')
  CSS.highlights?.delete('opendoc-pending')
}
function forkFrom(s: Session) {
  const { anchor, prompt } = forking!
  stopForking()
  startChat(undefined, s.id, anchor, prompt)
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && forking) stopForking()
})

// ---- Terminal panel ----

type Term = { term: Terminal; fit: FitAddon; ws: WebSocket; el: HTMLElement }
const terms = new Map<string, Term>()
let activeId: string | null = null

function sendResize(t: Term) {
  t.fit.fit()
  if (t.ws.readyState === WebSocket.OPEN) {
    t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }))
  }
}

// The agent's TUI turns on mouse reporting and uses it to select and edit text in its input, scroll,
// etc. — so let xterm forward the mouse to it (a plain drag is the agent's, so selecting in the input
// and deleting works). To still copy from the browser, hold Option (macOS, via
// macOptionClickForcesSelection) or Shift (elsewhere) to drag out an xterm selection, which is copied
// to the clipboard on select and on Cmd+C / Ctrl+Shift+C; Ctrl+Shift+V pastes; Shift+Enter is a
// newline (ESC+CR, what Claude Code's terminal-setup binds it to).
function enableCopyPaste(term: Terminal, send: (data: string) => void) {
  term.onSelectionChange(() => {
    const sel = term.getSelection()
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {})
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (e.key === 'Enter' && e.shiftKey) {
      send('\x1b\r')
      e.preventDefault()
      return false
    }
    // Copy: Cmd on macOS, Ctrl+Shift elsewhere — plain Ctrl+C stays an interrupt.
    if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
      e.preventDefault()
      return false
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard?.readText().then((t) => t && term.paste(t)).catch(() => {})
      e.preventDefault()
      return false
    }
    return true
  })
}

// The terminal shown by default: an agent session on the main checkout.
const mainTerm = { id: 'main', branch: 'main' }

function openTerminal(s: Pick<Session, 'id' | 'branch'>) {
  $('panel-close').hidden = s.id === mainTerm.id
  $('panel-title').textContent = s.branch
  let t = terms.get(s.id)
  if (!t) {
    const el = document.createElement('div')
    el.className = 'term'
    $('terms').append(el)
    // macOptionClickForcesSelection is a fallback for any mouse mode that slips through the filter.
    const term = new Terminal({
      fontFamily: 'Menlo, monospace',
      fontSize: 13,
      theme: { background: '#16181d' },
      macOptionClickForcesSelection: true,
      // Animate wheel scrolling and move more lines per notch so it feels smooth, not stuttery.
      smoothScrollDuration: 120,
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // GPU renderer: eliminates the DOM renderer's scroll jank. If the WebGL context is
    // unavailable or lost, dispose it so xterm falls back to the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unsupported here — stay on the DOM renderer.
    }
    const ws = new WebSocket(wsUrl(`/pty/${s.id}`))
    const send = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    }
    enableCopyPaste(term, send)
    t = { term, fit, ws, el }
    const cur = t
    ws.onopen = () => sendResize(cur)
    ws.onmessage = (e) => term.write(e.data)
    term.onData(send)
    terms.set(s.id, t)
  }
  for (const [id, x] of terms) x.el.hidden = id !== s.id
  activeId = s.id
  requestAnimationFrame(() => {
    sendResize(t!)
    t!.term.focus()
    layoutCards()
  })
}

function closeTerminal(id: string) {
  const t = terms.get(id)
  if (t) {
    t.ws.close()
    t.term.dispose()
    t.el.remove()
    terms.delete(id)
  }
  if (activeId === id) openTerminal(mainTerm)
}

$('panel-close').onclick = () => openTerminal(mainTerm)

new ResizeObserver(() => {
  const t = activeId && terms.get(activeId)
  if (t) sendResize(t)
}).observe($('terms'))

// ---- Picker settings inputs ----

// A workload's agent command (default 'claude') and its sparse dirs (each in its own input; empty =
// full checkout). Shown on the workload page, editable before opening, and saved with the workload.
type WorkloadInfo = { id: string; title: string; agent: string; sparse: string[] }
const pickerAgentInput = $<HTMLInputElement>('picker-agent-cmd')

function addSparseInput(value = '') {
  const row = document.createElement('div')
  row.className = 'sparse-row'
  const input = document.createElement('input')
  input.className = 'sparse-input'
  input.placeholder = 'e.g. spark/dbr'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = value
  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'sparse-del'
  del.textContent = '×'
  del.title = 'Remove'
  del.onclick = () => row.remove()
  row.append(input, del)
  $('sparse-list').append(row)
  return input
}
// Always keep at least one (empty) row, so there's a field to type into.
function setSparseInputs(dirs: string[]) {
  $('sparse-list').replaceChildren()
  for (const d of dirs.length ? dirs : ['']) addSparseInput(d)
}
const getSparseInputs = () =>
  [...$('sparse-list').querySelectorAll<HTMLInputElement>('.sparse-input')].map((i) => i.value.trim()).filter(Boolean)

$('sparse-add').onclick = () => addSparseInput().focus()

// ---- Divider ----

$('divider').onpointerdown = (e) => {
  const divider = $('divider')
  divider.setPointerCapture(e.pointerId)
  divider.onpointermove = (ev) => {
    const left = $('doc').getBoundingClientRect().left
    const pct = Math.min(80, Math.max(20, ((ev.clientX - left) / window.innerWidth) * 100))
    $('doc').style.flex = `0 0 ${pct}%`
  }
  divider.onpointerup = () => {
    divider.onpointermove = null
    layoutCards()
  }
}

// ---- Workload tabs ----

const tabsKey = () => `opendoc:tabs:${clientProject}`
function loadTabs() {
  try {
    const v = JSON.parse(localStorage.getItem(tabsKey()) || '[]')
    openTabs = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    openTabs = []
  }
}
const saveTabs = () => {
  try {
    localStorage.setItem(tabsKey(), JSON.stringify(openTabs))
  } catch {}
}
function addTab(id: string) {
  if (!openTabs.includes(id)) {
    openTabs.push(id)
    saveTabs()
  }
}
function removeTab(id: string) {
  openTabs = openTabs.filter((x) => x !== id)
  saveTabs()
}

// A tab's label: the workload's doc title, else its date-time from the id.
function tabTitle(id: string) {
  const w = allWorkloads.find((x) => x.id === id)
  if (w?.title) return w.title
  const m = id.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/)
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : id
}

function renderTabs() {
  $('tabs').replaceChildren(
    ...openTabs.map((id) => {
      const tab = document.createElement('div')
      tab.className = 'tab' + (id === activeWorkload ? ' active' : '')
      tab.title = id
      // The whole tab switches; only the close button (below) is exempt.
      tab.onclick = () => switchWorkload(id)
      const label = document.createElement('span')
      label.className = 'tab-label'
      label.textContent = tabTitle(id)
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.textContent = '×'
      close.title = 'Close workload'
      close.onclick = (e) => {
        e.stopPropagation()
        closeTab(id)
      }
      tab.append(label, close)
      return tab
    }),
  )
}

// Fetch the project's workloads (for tab titles) and drop tabs whose workload no longer exists.
async function refreshWorkloads() {
  const data = await (await fetch('/api/workloads')).json()
  allWorkloads = data.workloads ?? []
  if (data.project) clientProject = data.project
  openTabs = openTabs.filter((id) => allWorkloads.some((w: WorkloadInfo) => w.id === id))
  saveTabs()
  renderTabs()
}

// (Re)connect the events socket, e.g. after the server was restarted and the old one closed.
function ensureEventsWs() {
  if (eventsWs && eventsWs.readyState <= WebSocket.OPEN) return
  eventsWs = new WebSocket(wsUrl('/events'))
  eventsWs.onmessage = onEvent
}

// The server forgets the open project when it restarts, while the browser keeps it cached — so any
// project-scoped call (opening a workload, the sparse-dir check) would run against the wrong directory.
// Re-establish the project first so it runs against the right repo. Returns false if we can't.
async function ensureProject(): Promise<boolean> {
  if (!clientProject) return false
  const data = await (await fetch('/api/workloads')).json()
  if (data.project) return true
  const res = await post('/api/project', { path: clientProject })
  return res.ok
}

// Dispose every open terminal — session ids and the main terminal differ per workload.
function resetTerminals() {
  for (const [, t] of terms) {
    t.ws.close()
    t.term.dispose()
    t.el.remove()
  }
  terms.clear()
  activeId = null
}

// Reflect a workload the server has just made active: reset the view to it. The server broadcasts the
// workload's session list and main-agent state, so we don't clear the cards here (that would wipe a
// list that may have already arrived); the root doc is reopened fresh.
function applySwitch(id: string) {
  activeWorkload = id
  addTab(id)
  renderTabs()
  ensureEventsWs()
  history.replaceState(null, '', location.pathname)
  mainBusy = false
  resetTerminals()
  openDoc(DEFAULT_DOC)
  openTerminal(mainTerm)
}

async function switchWorkload(id: string) {
  if (id === activeWorkload) return
  if (!(await ensureProject())) return alert('Reopen the project folder first')
  const res = await post('/api/workload', { id })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  applySwitch(id)
  refreshWorkloads()
}

async function closeTab(id: string) {
  await post('/api/workload/close', { id })
  removeTab(id)
  if (id !== activeWorkload) return renderTabs()
  // Closing the active tab: move to another open one, or fall back to the picker.
  activeWorkload = ''
  const next = openTabs[0]
  if (next) return switchWorkload(next)
  resetTerminals()
  renderTabs()
  openPickerForAdd()
}

// The + button: choose or create a workload to open as a new tab (the project is already picked).
async function openPickerForAdd() {
  await refreshWorkloads()
  workloads = allWorkloads
  pickerMode = 'add'
  $('pick-folder').hidden = true
  $('pick-workload').hidden = false
  $('workload-cancel').hidden = false
  $('workload-project').textContent = clientProject
  renderWorkloads()
  selectNew()
  $('picker').hidden = false
}
$('tab-add').onclick = () => openPickerForAdd()
// Cancel only dismisses when there's an active workload to return to (the initial pick has none).
$('workload-cancel').onclick = () => {
  if (activeWorkload) $('picker').hidden = true
}

// ---- Picker: choose a project folder, then a workload in it ----

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function showDir(dir: string) {
  const res = await fetch(`/api/dirs?path=${encodeURIComponent(dir)}`)
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  $('dir-path').textContent = data.path
  const entries: [string, string][] = data.dirs.map((d: string) => [d, `${data.path}/${d}`])
  if (data.parent !== data.path) entries.unshift(['..', data.parent])
  $('dir-list').replaceChildren(
    ...entries.map(([name, to]) => {
      const li = document.createElement('li')
      li.textContent = name
      li.onclick = () => showDir(to)
      return li
    }),
  )
  $('dir-choose').onclick = () => chooseProject(data.path)
}

// The workloads in the picked project (newest first) and which one the config below is for; a null
// selection means a new workload.
let workloads: WorkloadInfo[] = []
let selectedId: string | null = null

async function chooseProject(dir: string) {
  const res = await post('/api/project', { path: dir })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  clientProject = data.project
  loadTabs()
  allWorkloads = data.workloads
  pickerMode = 'start'
  $('pick-folder').hidden = true
  $('pick-workload').hidden = false
  $('workload-cancel').hidden = true
  $('workload-project').textContent = data.project
  workloads = data.workloads
  renderWorkloads()
  // Open to the most recent workload if there is one; otherwise set up a new one.
  if (workloads.length) selectWorkload(workloads[0].id)
  else selectNew()
}

function renderWorkloads() {
  $('workload-list').replaceChildren(
    ...workloads.map((w) => {
      const li = document.createElement('li')
      li.dataset.id = w.id
      // Ids start with yyyymmdd-hhmm.
      const [, y, mo, d, h, mi] = w.id.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/)!
      const label = document.createElement('span')
      label.textContent = `${y}-${mo}-${d} ${h}:${mi}  ${w.title}`
      li.append(label)
      li.title = w.id
      li.onclick = () => selectWorkload(w.id)
      const del = document.createElement('button')
      del.className = 'workload-del'
      del.textContent = '×'
      del.title = 'Delete workload'
      del.onclick = async (e) => {
        // Don't also select the workload.
        e.stopPropagation()
        if (!confirm('Delete this workload? Its docs and any sessions will be removed.')) return
        const r = await post('/api/workload/delete', { id: w.id })
        const out = await r.json()
        if (!r.ok) return alert(out.error)
        workloads = out.workloads
        allWorkloads = out.workloads
        removeTab(w.id)
        if (activeWorkload === w.id) activeWorkload = ''
        renderTabs()
        renderWorkloads()
        if (selectedId === w.id) selectNew()
      }
      li.append(del)
      return li
    }),
  )
  highlightSelected()
}

function highlightSelected() {
  for (const li of $('workload-list').querySelectorAll<HTMLElement>('li')) {
    li.classList.toggle('selected', li.dataset.id === selectedId)
  }
}

function fillConfig(agent: string, sparse: string[]) {
  pickerAgentInput.value = agent
  setSparseInputs(sparse)
}

// Select an existing workload: show (and let the user edit) its own settings before opening.
function selectWorkload(id: string) {
  selectedId = id
  const w = workloads.find((x) => x.id === id)
  if (w) fillConfig(w.agent, w.sparse)
  highlightSelected()
  $('workload-open').textContent = 'Open workload'
}

// A new workload copies the most recent workload's settings (the list is newest-first).
function selectNew() {
  selectedId = null
  const recent = workloads[0]
  fillConfig(recent?.agent ?? 'claude', recent?.sparse ?? [])
  highlightSelected()
  $('workload-open').textContent = 'Create workload'
}
$('workload-new').onclick = selectNew

$('workload-open').onclick = async () => {
  if (!(await ensureProject())) return alert('Reopen the project folder first')
  const res = await post('/api/workload', {
    id: selectedId ?? undefined,
    agent: pickerAgentInput.value,
    sparse: getSparseInputs(),
  })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  $('picker').hidden = true
  if (pickerMode === 'start') start(data.id)
  else applySwitch(data.id)
  refreshWorkloads()
}

function start(active: string) {
  $('picker').hidden = true
  $('app').hidden = false
  ensureEventsWs()
  activeWorkload = active
  addTab(active)
  renderTabs()
  openDoc(docFromUrl())
  openTerminal(mainTerm)
}

// A reload goes straight back to the active workload, restoring the project's tab bar.
async function boot() {
  const data = await (await fetch('/api/workloads')).json()
  allWorkloads = data.workloads ?? []
  clientProject = data.project || ''
  if (data.active) {
    loadTabs()
    start(data.active)
    refreshWorkloads()
  } else {
    $('picker').hidden = false
    showDir('')
  }
}
boot()
