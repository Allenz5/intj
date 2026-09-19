import { marked } from 'marked'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Session = { id: string; quote: string; prompt: string; branch: string; status: 'running' | 'exited' }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const wsUrl = (p: string) => `ws://${location.host}${p}`

let docText = ''
let sessions: Session[] = []

// ---- Document ----

const events = new WebSocket(wsUrl('/events'))
events.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'content') {
    if (msg.name) $('doc-name').textContent = msg.name
    docText = msg.text
    $('preview').innerHTML = marked.parse(docText) as string
    layoutCards()
  } else if (msg.type === 'sessions') {
    sessions = msg.list
    renderCards()
  }
}

// ---- Anchoring a quote in the rendered preview ----

// Match ignoring whitespace, since a selection's text and the DOM's text nodes differ in line breaks.
function findRange(root: HTMLElement, quote: string): Range | null {
  const chars: { node: Text; offset: number }[] = []
  let flat = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.data.length; i++) {
      if (/\s/.test(n.data[i])) continue
      chars.push({ node: n, offset: i })
      flat += n.data[i]
    }
  }
  const needle = quote.replace(/\s+/g, '')
  const at = needle ? flat.indexOf(needle) : -1
  if (at < 0) return null
  const start = chars[at]
  const end = chars[at + needle.length - 1]
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
}

// ---- Comment cards ----

const cardErrors = new Map<string, string>()

function renderCards() {
  const gutter = $('gutter')
  gutter.innerHTML = ''
  for (const s of sessions) {
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.id = s.id
    card.innerHTML = `
      <div class="card-quote"></div>
      <div class="card-prompt"></div>
      <div class="card-meta"><code>${s.branch}</code>${s.status === 'exited' ? ' · 已退出' : ''}</div>
      <div class="card-actions">
        <button data-act="open">打开终端</button>
        <button data-act="merge">Merge</button>
        <button data-act="end">End</button>
      </div>
      <div class="card-error" hidden></div>`
    card.querySelector('.card-quote')!.textContent = s.quote
    card.querySelector('.card-prompt')!.textContent = s.prompt
    const err = cardErrors.get(s.id)
    if (err) showCardError(card, err)
    card.onclick = (e) => {
      const act = (e.target as HTMLElement).dataset.act
      if (act === 'open') openTerminal(s)
      else if (act === 'merge' || act === 'end') runAction(s, act, card)
    }
    gutter.append(card)
  }
  layoutCards()
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
  showCardError(card, res.ok ? (act === 'merge' ? '已合并' : '') : data.error)
  card.querySelector('.card-error')!.classList.toggle('ok', res.ok)
  if (res.ok && act === 'end') closeTerminal(s.id)
}

// Place each card level with its quote, pushing down any that would overlap.
function layoutCards() {
  const preview = $('preview')
  const gutter = $('gutter')
  const base = gutter.getBoundingClientRect().top
  const ranges: Range[] = []
  let floor = 0
  const cards = [...gutter.querySelectorAll<HTMLElement>('.card')]
  const placed = cards.map((card) => {
    const s = sessions.find((x) => x.id === card.dataset.id)!
    const range = findRange(preview, s.quote)
    if (range) ranges.push(range)
    card.classList.toggle('orphan', !range)
    return { card, top: range ? range.getBoundingClientRect().top - base : Infinity }
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

let pendingQuote = ''
const popup = $('popup')
const popupInput = $<HTMLInputElement>('popup-input')

function showPopup(quote: string, range: Range | null, x: number, y: number) {
  pendingQuote = quote
  // Focusing the input clears the selection, so keep it visible as a highlight.
  if (range) CSS.highlights?.set('intj-pending', new Highlight(range))
  popup.style.left = `${Math.min(x, window.innerWidth - 340)}px`
  popup.style.top = `${y + 6}px`
  popup.hidden = false
  popupInput.value = ''
  popupInput.focus()
}

$('preview').addEventListener('mouseup', (e) => {
  if (e.button !== 0) return
  const sel = getSelection()
  const text = sel?.toString().trim() ?? ''
  if (!sel || !text) return
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  showPopup(text, range.cloneRange(), rect.left, rect.bottom)
})

// Right-click opens a session on the selection, or else on the block under the cursor.
$('preview').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const sel = getSelection()
  const text = sel?.toString().trim() ?? ''
  if (sel && text) return showPopup(text, sel.getRangeAt(0).cloneRange(), e.clientX, e.clientY)
  const block = (e.target as HTMLElement).closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th')
  const quote = block?.textContent?.trim() ?? ''
  const range = quote ? findRange($('preview'), quote) : null
  showPopup(quote, range, e.clientX, e.clientY)
})

function hidePopup() {
  popup.hidden = true
  CSS.highlights?.delete('intj-pending')
}
document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target as Node)) hidePopup()
})

async function startChat() {
  const prompt = popupInput.value.trim()
  if (!prompt) return popupInput.focus()
  hidePopup()
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quote: pendingQuote, prompt }),
  })
  const data = await res.json()
  if (!res.ok) return alert(data.error)
  openTerminal(data)
}
$('popup-start').onclick = startChat
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

function openTerminal(s: Session) {
  $('terms-empty').hidden = true
  $('panel-close').hidden = false
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
  if (activeId === id) clearPanel()
}

function clearPanel() {
  for (const x of terms.values()) x.el.hidden = true
  $('terms-empty').hidden = false
  $('panel-close').hidden = true
  $('panel-title').textContent = 'terminal'
  activeId = null
}
$('panel-close').onclick = clearPanel

new ResizeObserver(() => {
  const t = activeId && terms.get(activeId)
  if (t) sendResize(t)
}).observe($('terms'))

// ---- Divider ----

$('divider').onpointerdown = (e) => {
  const divider = $('divider')
  divider.setPointerCapture(e.pointerId)
  divider.onpointermove = (ev) => {
    const pct = Math.min(80, Math.max(20, (ev.clientX / window.innerWidth) * 100))
    $('doc').style.flex = `0 0 ${pct}%`
  }
  divider.onpointerup = () => {
    divider.onpointermove = null
    layoutCards()
  }
}
