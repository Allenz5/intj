import { marked } from 'marked'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// Where a comment sits: its quote plus the text around it (whitespace removed) and its relative position.
type Anchor = { quote: string; prefix: string; suffix: string; pos: number }
type Session = Anchor & { id: string; doc: string; prompt: string; branch: string; status: 'running' | 'exited'; busy: boolean; unmerged: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const wsUrl = (p: string) => `ws://${location.host}${p}`

const DEFAULT_DOC = 'README.md'
let docName = ''
let docText = ''
let sessions: Session[] = []
// Id of the session whose worktree doc is shown while its Merge button is hovered.
let previewing: string | null = null

// ---- Document ----

const events = new WebSocket(wsUrl('/events'))
events.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'content') {
    if (msg.name !== docName) return
    docText = msg.text
    // A merge while hovering changes the main doc, so re-diff against it.
    const s = sessions.find((x) => x.id === previewing)
    if (s) showWorktreeDoc(s)
    else showMainDoc()
  } else if (msg.type === 'sessions') {
    sessions = msg.list
    renderCards()
    // Sent on connect (after the doc name) and after merges, which can change files.
    loadTree()
  } else if (msg.type === 'activity') {
    // Update in place: re-rendering the cards would cut off a Merge hover preview.
    const s = sessions.find((x) => x.id === msg.id)
    const card = document.querySelector<HTMLElement>(`.card[data-id="${msg.id}"]`)
    if (s && card) {
      s.busy = msg.busy
      s.unmerged = msg.unmerged
      renderState(card, s)
    }
  }
}

async function openDoc(name: string) {
  docName = name
  const { text } = await (await fetch(`/api/doc?name=${encodeURIComponent(name)}`)).json()
  // Another link may have been clicked while fetching.
  if (docName !== name) return
  $('doc-name').textContent = name
  docText = text
  showMainDoc()
  renderCards()
  loadTree()
  const { parent } = await (await fetch(`/api/parent?name=${encodeURIComponent(name)}`)).json()
  if (docName !== name) return
  $('doc-up').hidden = !parent
  $('doc-up').title = parent ?? ''
  $('doc-up').onclick = () => goToDoc(parent)
}
function goToDoc(name: string) {
  history.pushState(null, '', `?doc=${encodeURIComponent(name)}`)
  openDoc(name)
}
const docFromUrl = () => new URLSearchParams(location.search).get('doc') ?? DEFAULT_DOC
window.onpopstate = () => openDoc(docFromUrl())
openDoc(docFromUrl())

// A relative link to an md file opens that doc in place, resolved against the current doc's folder.
$('preview').addEventListener('click', (e) => {
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
  if (!href || /^([a-z]+:|\/|#)/i.test(href)) return
  const file = href.split('#')[0]
  if (!file.endsWith('.md')) return
  e.preventDefault()
  goToDoc(decodeURIComponent(new URL(file, `http://x/${docName}`).pathname.slice(1)))
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

// ---- Directory tree ----

type Dir = Map<string, Dir | null>

async function loadTree() {
  const { files } = (await (await fetch('/api/tree')).json()) as { files: string[] }
  const root: Dir = new Map()
  for (const f of files) {
    const parts = f.split('/')
    let dir = root
    for (const p of parts.slice(0, -1)) {
      if (!dir.get(p)) dir.set(p, new Map())
      dir = dir.get(p)!
    }
    dir.set(parts.at(-1)!, null)
  }
  // Keep folders the user expanded open across reloads.
  const open = new Set([...$('tree-list').querySelectorAll<HTMLElement>('details[open]')].map((d) => d.dataset.path))
  $('tree-list').replaceChildren(renderDir(root, '', open))
}

// Directories first, each a <details> so it folds on its own.
function renderDir(dir: Dir, prefix: string, open: Set<string | undefined>): HTMLElement {
  const ul = document.createElement('ul')
  const entries = [...dir].sort(([a, x], [b, y]) => Number(!x) - Number(!y) || a.localeCompare(b))
  for (const [name, sub] of entries) {
    const li = document.createElement('li')
    const path = prefix + name
    if (sub) {
      const details = document.createElement('details')
      details.dataset.path = path
      details.open = open.has(path)
      const summary = document.createElement('summary')
      summary.textContent = name
      details.append(summary, renderDir(sub, path + '/', open))
      li.append(details)
    } else {
      li.textContent = name
      li.classList.toggle('current', path === $('doc-name').textContent)
    }
    ul.append(li)
  }
  return ul
}

$('tree-toggle').onclick = () => {
  const collapsed = $('tree').classList.toggle('collapsed')
  $('tree-toggle').textContent = collapsed ? '»' : '«'
  $('tree-toggle').title = collapsed ? '展开' : '折叠'
  requestAnimationFrame(layoutCards)
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
        <button data-act="open">打开终端</button>
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
      const act = (e.target as HTMLElement).dataset.act
      if (act === 'open') openTerminal(s)
      else if (act === 'merge' || act === 'end') runAction(s, act, card)
    }
    gutter.append(card)
  }
  layoutCards()
}

function renderState(card: HTMLElement, s: Session) {
  const state = s.status === 'exited' ? 'exited' : s.busy ? 'busy' : 'done'
  const el = card.querySelector<HTMLElement>('.card-state')!
  el.className = `card-state ${state}`
  el.textContent = { busy: '进行中', done: '已完成', exited: '已退出' }[state]
  // Merge only shows while the worktree has something main doesn't.
  card.querySelector<HTMLElement>('[data-act="merge"]')!.hidden = !s.unmerged
  // A button hidden under the pointer never fires its mouseleave.
  if (!s.unmerged && previewing === s.id) {
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
  showCardError(
    card,
    data.handedOff ? '自动合并失败，已交给主干终端按 merge skill 处理' : ok ? (act === 'merge' ? '已合并' : '') : data.error,
  )
  card.querySelector('.card-error')!.classList.toggle('ok', ok)
  if (data.handedOff) openTerminal(mainTerm)
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
    const s = sessions.find((x) => x.id === card.dataset.id)!
    const hit = f.chars.length ? locate(f, s) : null
    if (hit && !hit.range.collapsed) ranges.push(hit.range)
    card.classList.toggle('orphan', !hit?.exact)
    return { card, top: hit ? hit.range.getBoundingClientRect().top - base : Infinity }
  })
  placed.sort((a, b) => a.top - b.top)
  for (const p of placed) {
    const top = Math.max(p.top === Infinity ? floor : p.top, floor)
    p.card.style.top = `${top}px`
    floor = top + p.card.offsetHeight + 8
  }
  gutter.style.minHeight = `${floor}px`
  CSS.highlights?.set('intj-quote', new Highlight(...ranges))
}
window.addEventListener('resize', layoutCards)

// ---- Selection popup ----

let pendingAnchor: Anchor = { quote: '', prefix: '', suffix: '', pos: 0 }
const popup = $('popup')
const popupInput = $<HTMLInputElement>('popup-input')

function showPopup(quote: string, range: Range | null, x: number, y: number) {
  pendingAnchor = range ? anchorOf($('preview'), range, quote) : { quote, prefix: '', suffix: '', pos: 0 }
  // Focusing the input clears the selection, so keep it visible as a highlight.
  if (range) CSS.highlights?.set('intj-pending', new Highlight(range))
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
  CSS.highlights?.delete('intj-pending')
}
document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target as Node)) hidePopup()
})

// A skill makes the input optional: it becomes extra conditions for the skill.
async function startChat(skill?: string) {
  const prompt = popupInput.value.trim()
  if (!prompt && !skill) return popupInput.focus()
  hidePopup()
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc: docName, anchor: pendingAnchor, prompt, skill }),
  })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  openTerminal(data)
}
$('popup-start').onclick = () => startChat()
$('popup-split').onclick = () => startChat('split-doc')
popupInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) startChat()
  if (e.key === 'Escape') hidePopup()
}

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

// The terminal shown by default: an agent session on the main checkout.
const mainTerm = { id: 'main', branch: '主干' }

function openTerminal(s: Pick<Session, 'id' | 'branch'>) {
  $('panel-close').hidden = s.id === mainTerm.id
  $('panel-title').textContent = s.branch
  let t = terms.get(s.id)
  if (!t) {
    const el = document.createElement('div')
    el.className = 'term'
    $('terms').append(el)
    const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, theme: { background: '#16181d' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const ws = new WebSocket(wsUrl(`/pty/${s.id}`))
    t = { term, fit, ws, el }
    const cur = t
    ws.onopen = () => sendResize(cur)
    ws.onmessage = (e) => term.write(e.data)
    term.onData((data) => ws.send(JSON.stringify({ type: 'input', data })))
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
openTerminal(mainTerm)

new ResizeObserver(() => {
  const t = activeId && terms.get(activeId)
  if (t) sendResize(t)
}).observe($('terms'))

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
