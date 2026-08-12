// Reusable pieces: scrolling list, chrome, and the modal family.
//
// Modals run their own key loop and draw over the frame beneath them, so they
// take a `redraw` callback that repaints the background before each frame.

import { S, accountStyle } from './theme.mjs'
import { BORDER } from './screen.mjs'
import { stringWidth, truncate, fit, asText } from './width.mjs'
import { isPrintable } from './keys.mjs'

// ── Scrolling list ───────────────────────────────────────────────────
// Items may be selectable rows or non-selectable headers/separators. The
// cursor only ever lands on selectable ones.

export class List {
  constructor(items = []) {
    this.items = items
    this.cursor = 0
    this.offset = 0
    this.#snapToSelectable(1)
  }

  setItems(items, { keepCursor = true } = {}) {
    const prev = this.selected()
    this.items = items
    if (keepCursor && prev && prev.id !== undefined) {
      const i = items.findIndex((it) => it.id === prev.id)
      if (i >= 0) { this.cursor = i; return }
    }
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1))
    this.#snapToSelectable(1)
  }

  get length() {
    return this.items.length
  }

  selectable(i) {
    const it = this.items[i]
    return !!it && it.selectable !== false
  }

  #snapToSelectable(dir) {
    if (!this.items.length) { this.cursor = 0; return }
    let i = Math.max(0, Math.min(this.cursor, this.items.length - 1))
    const start = i
    while (!this.selectable(i)) {
      i += dir
      if (i < 0) i = this.items.length - 1
      if (i >= this.items.length) i = 0
      if (i === start) break
    }
    this.cursor = i
  }

  selected() {
    return this.items[this.cursor] || null
  }

  move(delta) {
    if (!this.items.length) return
    let i = this.cursor
    const n = this.items.length
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n
      if (this.selectable(i)) { this.cursor = i; return }
    }
  }

  moveTo(i) {
    this.cursor = Math.max(0, Math.min(i, this.items.length - 1))
    this.#snapToSelectable(1)
  }

  first() {
    this.cursor = 0
    this.#snapToSelectable(1)
  }

  last() {
    this.cursor = this.items.length - 1
    this.#snapToSelectable(-1)
  }

  page(delta, height) {
    this.move(delta * Math.max(1, height - 1))
  }

  // Keep the cursor inside the visible window.
  #reflow(height) {
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + height) this.offset = this.cursor - height + 1
    const maxOff = Math.max(0, this.items.length - height)
    this.offset = Math.max(0, Math.min(this.offset, maxOff))
  }

  // Which item is at screen row `my`? -1 when the point is outside the list or
  // past its last row. Depends on `rect`, recorded by the last draw().
  hitTest(mx, my) {
    const r = this.rect
    if (!r) return -1
    if (mx < r.x || mx >= r.x + r.w || my < r.y || my >= r.y + r.h) return -1
    const i = this.offset + (my - r.y)
    return i < this.items.length ? i : -1
  }

  // renderRow(item, { selected, width, index }) → [{ text, style }] or string
  draw(scr, x, y, w, h, renderRow, { focused = true } = {}) {
    this.rect = { x, y, w, h }
    this.#reflow(h)
    const needsBar = this.items.length > h
    const listW = needsBar ? w - 1 : w

    for (let row = 0; row < h; row++) {
      const i = this.offset + row
      if (i >= this.items.length) break
      const item = this.items[i]
      const selected = i === this.cursor
      const spans = renderRow(item, { selected, width: listW, index: i, focused })
      const yy = y + row

      if (typeof spans === 'string') {
        const style = selected ? (focused ? S.selOn : S.sel) : S.base
        scr.putRow(x, yy, listW, spans, style)
      } else {
        // Paint the row background first so a selected row highlights fully.
        if (selected) scr.fill(x, yy, listW, 1, ' ', focused ? S.selOn : S.sel)
        let cx = x
        for (const span of spans) {
          if (cx >= x + listW) break
          const style = selected
            ? (focused ? S.selOn : S.sel)
            : (span.style ?? S.base)
          const room = x + listW - cx
          cx = scr.put(cx, yy, truncate(span.text, room), style)
        }
      }
    }

    if (needsBar) scrollbar(scr, x + w - 1, y, h, this.items.length, this.offset)
  }
}

export function scrollbar(scr, x, y, h, total, offset) {
  if (total <= h) return
  const thumb = Math.max(1, Math.round((h * h) / total))
  const maxOff = total - h
  const pos = maxOff > 0 ? Math.round((offset / maxOff) * (h - thumb)) : 0
  for (let i = 0; i < h; i++) {
    const on = i >= pos && i < pos + thumb
    scr.put(x, y + i, on ? '┃' : '│', on ? S.accent : S.dim)
  }
}

// ── Chrome ───────────────────────────────────────────────────────────

// Returns the clickable region of each tab so the app can route mouse presses.
export function drawHeader(scr, { tabs = [], active = 0, right = '', alert = '', account = null } = {}) {
  const w = scr.cols
  scr.fill(0, 0, w, 1, ' ', S.base)
  let x = 1
  x = scr.put(x, 0, 'cl', S.title)
  x = scr.put(x, 0, '  ', S.base)

  // Which subscription this cl is looking at. Far left, on every screen, so
  // the answer to "which account am I in" never depends on the panel.
  if (account?.label) {
    x = scr.put(x, 0, account.label, accountStyle(account.id))
    x = scr.put(x, 0, '  ', S.base)
  }

  const rects = []
  tabs.forEach((t, i) => {
    const on = i === active
    const from = x
    x = scr.put(x, 0, ` ${i + 1} `, on ? S.accent : S.dim)
    x = scr.put(x, 0, t, on ? S.title : S.muted)
    rects.push({ index: i, x: from, w: x - from })
    x = scr.put(x, 0, '  ', S.base)
  })

  // The alert sits to the right of the status text so it is the last thing on
  // the line and hard to miss.
  const rw = stringWidth(right)
  const aw = alert ? stringWidth(alert) + 2 : 0
  if (right && w - 1 - rw - aw > x) scr.put(w - 1 - rw - aw, 0, right, S.muted)
  if (alert && w - 1 - aw > x) scr.put(w - 1 - stringWidth(alert), 0, alert, S.warn)

  scr.hline(0, 1, w, S.border)
  return rects
}

// keys: [['enter', 'resume'], ['n', 'new'], …]
export function drawFooter(scr, keys, { message = null, messageStyle = S.muted } = {}) {
  const y = scr.rows - 1
  scr.fill(0, y, scr.cols, 1, ' ', S.base)
  if (message) {
    scr.put(1, y, truncate(message, scr.cols - 2), messageStyle)
    return
  }
  let x = 1
  for (const [k, label] of keys) {
    const need = stringWidth(k) + stringWidth(label) + 2
    if (x + need >= scr.cols - 1) break
    x = scr.put(x, y, k, S.key)
    x = scr.put(x, y, ' ' + label, S.dim)
    x = scr.put(x, y, '  ', S.base)
  }
}

// A label/value row used by the Launch screen and the typed config forms.
export function drawField(scr, x, y, w, label, value, { selected = false, labelW = 10, style = S.base } = {}) {
  if (selected) scr.fill(x, y, w, 1, ' ', S.sel)
  scr.put(x + 1, y, fit(label, labelW), selected ? S.accent : S.muted)
  scr.put(x + 1 + labelW + 1, y, truncate(value, w - labelW - 3), selected ? S.title : style)
}

// Horizontal enum picker: ▸opus  sonnet  haiku
export function drawEnum(scr, x, y, w, options, current, { selected = false, labelW = 0 } = {}) {
  let cx = x + labelW
  for (const opt of options) {
    const on = opt === current
    const text = (on ? '▸' : ' ') + opt
    if (cx + stringWidth(text) + 1 > x + w) break
    const style = on
      ? (selected ? S.title : S.accent)
      : (selected ? S.muted : S.dim)
    cx = scr.put(cx, y, text, style)
    cx = scr.put(cx, y, ' ', S.base)
  }
}

export function checkbox(on) {
  return on ? '[x]' : '[ ]'
}

// ── Gauges ───────────────────────────────────────────────────────────

// Eighth-width blocks, so a bar moves smoothly rather than a character at a
// time — at typical widths that is eight times the resolution.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Horizontal bar. `frac` is clamped to 0..1; the track is drawn behind so the
// full width always reads as the scale.
export function drawBar(scr, x, y, w, frac, { style = S.ok, track = S.dim } = {}) {
  if (w <= 0) return
  const f = Math.max(0, Math.min(1, Number(frac) || 0))
  const total = w * 8
  const filled = Math.round(f * total)
  const whole = Math.floor(filled / 8)
  const rest = filled % 8

  scr.put(x, y, '─'.repeat(w), track)
  if (whole > 0) scr.put(x, y, '█'.repeat(Math.min(whole, w)), style)
  if (rest > 0 && whole < w) scr.put(x + whole, y, EIGHTHS[rest], style)
}

// Compact inline meter: ▓▓▓▓░░░░  used where a full-width bar would dominate.
export function meter(frac, w = 8, { full = '▰', empty = '▱' } = {}) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0))
  const on = Math.round(f * w)
  return full.repeat(on) + empty.repeat(Math.max(0, w - on))
}

export function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n)
}

// ── Mouse ────────────────────────────────────────────────────────────

// Shared list behaviour: wheel scrolls, a click selects, and clicking the row
// that is already selected activates it — the same "click twice" idiom lazygit
// uses, without needing double-click timing.
export function listMouse(list, m, { wheelRows = 3 } = {}) {
  if (m.wheel) {
    list.move(m.wheel === 'up' ? -wheelRows : wheelRows)
    return 'moved'
  }
  if (!m.press || m.button !== 0) return false
  const i = list.hitTest(m.x, m.y)
  if (i < 0 || !list.selectable(i)) return false
  const again = list.cursor === i
  list.moveTo(i)
  return again ? 'activate' : 'moved'
}

// ── Modals ───────────────────────────────────────────────────────────

function panel(scr, w, h) {
  const x = Math.max(0, Math.floor((scr.cols - w) / 2))
  const y = Math.max(1, Math.floor((scr.rows - h) / 2))
  scr.fill(x, y, w, h, ' ', S.base)
  return [x, y]
}

// Track overlay nesting so background work (the toast expiry timer) knows not
// to repaint over an open modal.
export async function overlay(app, fn) {
  app.overlays = (app.overlays ?? 0) + 1
  try {
    return await fn()
  } finally {
    app.overlays = Math.max(0, (app.overlays ?? 1) - 1)
  }
}

// Yes/no. Returns true on confirm.
export async function confirm(app, { title, message, detail = '', danger = false, yes = 'Yes', no = 'Cancel' }) {
  const { screen: scr, kb } = app
  let choice = danger ? 1 : 0
  const lines = asText(message).split('\n')
  const widest = lines.reduce((m, l) => Math.max(m, stringWidth(l)), stringWidth(detail))

  return overlay(app, async () => {
  for (;;) {
    app.renderBase()
    const w = Math.max(24, Math.min(scr.cols - 6, Math.max(44, widest) + 6))
    const h = 6 + lines.length + (detail ? 2 : 0)
    const [x, y] = panel(scr, w, h)
    scr.box(x, y, w, h, { title, focused: true, style: danger ? S.err : S.borderOn })

    let ly = y + 2
    for (const line of lines) { scr.put(x + 3, ly, truncate(line, w - 6), S.base); ly++ }
    if (detail) { ly++; scr.put(x + 3, ly, truncate(detail, w - 6), S.dim); ly++ }

    const by = y + h - 2
    const labels = [yes, no]
    let bx = x + 3
    labels.forEach((label, i) => {
      const on = i === choice
      const text = ` ${label} `
      scr.put(bx, by, text, on ? (danger && i === 0 ? S.err : S.selOn) : S.dim)
      bx += stringWidth(text) + 2
    })
    scr.flush()

    const ev = await kb.next()
    if (ev.name === 'left' || ev.name === 'right' || ev.name === 'tab') choice = 1 - choice
    else if (ev.name === 'escape' || ev.name === 'n') return false
    else if (ev.name === 'y') return true
    else if (ev.name === 'enter') return choice === 0
  }
  })
}

// Single-line text input. Returns the string, or null on Escape.
export async function promptText(app, { title, label = '', value = '', placeholder = '', validate = null }) {
  const { screen: scr, kb } = app
  let buf = asText(value)
  let cursor = buf.length
  let error = null

  return overlay(app, async () => {
  for (;;) {
    app.renderBase()
    const w = Math.min(scr.cols - 6, 64)
    const h = label ? 8 : 7
    const [x, y] = panel(scr, w, h)
    scr.box(x, y, w, h, { title, focused: true })

    let ly = y + 2
    if (label) { scr.put(x + 3, ly, truncate(label, w - 6), S.muted); ly += 2 }

    const fieldW = w - 6
    scr.fill(x + 3, ly, fieldW, 1, ' ', S.sel)
    const shown = buf || placeholder
    scr.put(x + 3, ly, truncate(shown, fieldW), buf ? S.title : S.dim)
    // Draw the caret as a reversed cell.
    const cx = x + 3 + Math.min(stringWidth(buf.slice(0, cursor)), fieldW - 1)
    const under = buf[cursor] ?? ' '
    scr.put(cx, ly, under, S.selOn)

    if (error) scr.put(x + 3, y + h - 3, truncate(error, w - 6), S.err)
    scr.put(x + 3, y + h - 2, 'enter confirm   esc cancel', S.dim)
    scr.flush()

    const ev = await kb.next()
    if (ev.name === 'escape') return null
    if (ev.name === 'enter') {
      const trimmed = buf.trim()
      if (validate) {
        const problem = validate(trimmed)
        if (problem) { error = problem; continue }
      }
      return trimmed
    }
    if (ev.name === 'backspace') {
      if (cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor-- }
    } else if (ev.name === 'delete') {
      buf = buf.slice(0, cursor) + buf.slice(cursor + 1)
    } else if (ev.name === 'left') { cursor = Math.max(0, cursor - 1) }
    else if (ev.name === 'right') { cursor = Math.min(buf.length, cursor + 1) }
    else if (ev.name === 'home') { cursor = 0 }
    else if (ev.name === 'end') { cursor = buf.length }
    else if (ev.ctrl && ev.name === 'u') { buf = buf.slice(cursor); cursor = 0 }
    else if (ev.ctrl && ev.name === 'w') {
      const left = buf.slice(0, cursor).replace(/\S+\s*$/, '')
      cursor = left.length
      buf = left + buf.slice(cursor)
    } else if (ev.name === 'space') {
      buf = buf.slice(0, cursor) + ' ' + buf.slice(cursor); cursor++
    } else if (isPrintable(ev)) {
      buf = buf.slice(0, cursor) + ev.ch + buf.slice(cursor); cursor += ev.ch.length
    }
    error = null
  }
  })
}

// Overlay picker. `items` is [{ label, value, hint, style }]. An item's
// `style` wins over the default row styling — used by the colour picker, where
// the swatch is the point. Returns value or null.
export async function chooseFrom(app, { title, items, current = null, filterable = false }) {
  const { screen: scr, kb } = app
  let filter = ''
  const list = new List([])

  const refresh = () => {
    const f = filter.toLowerCase()
    const rows = items
      .filter((it) => !f || it.label.toLowerCase().includes(f))
      .map((it) => ({ ...it, id: String(it.value) }))
    list.setItems(rows)
  }
  refresh()
  if (current != null) {
    const i = list.items.findIndex((it) => it.value === current)
    if (i >= 0) list.moveTo(i)
  }

  // reduce, not spread — this list can hold every backup or every session.
  const maxLabel = items.reduce(
    (m, i) => Math.max(m, stringWidth(i.label) + stringWidth(i.hint || '') + 4), 20,
  )

  return overlay(app, async () => {
  for (;;) {
    app.renderBase()
    const w = Math.max(24, Math.min(scr.cols - 6, Math.max(40, maxLabel + 6)))
    const bodyH = Math.max(1, Math.min(items.length + (filterable ? 2 : 0), scr.rows - 10))
    const h = bodyH + 4
    const [x, y] = panel(scr, w, h)
    scr.box(x, y, w, h, { title, focused: true, hint: filterable ? '/ filter' : '' })

    let ly = y + 1
    let listH = h - 2
    if (filterable) {
      scr.put(x + 2, ly, '/ ' + (filter || ''), filter ? S.title : S.dim)
      ly++; listH--
    }

    list.draw(scr, x + 1, ly, w - 2, listH, (item, { selected }) => [
      { text: ' ' + (item.value === current ? '▸' : ' ') + ' ' + item.label, style: item.style || (item.value === current ? S.accent : S.base) },
      { text: item.hint ? '  ' + item.hint : '', style: S.dim },
    ])
    scr.flush()

    const ev = await kb.next()
    if (ev.name === 'escape') return null
    if (ev.name === 'enter') return list.selected()?.value ?? null
    if (ev.name === 'up' || (ev.ctrl && ev.name === 'p')) list.move(-1)
    else if (ev.name === 'down' || (ev.ctrl && ev.name === 'n')) list.move(1)
    else if (ev.ctrl && (ev.name === 'd' || ev.name === 'f')) list.page(1, listH)
    else if (ev.ctrl && (ev.name === 'u' || ev.name === 'b')) list.page(-1, listH)
    else if (ev.name === 'pageup') list.page(-1, listH)
    else if (ev.name === 'pagedown') list.page(1, listH)
    else if (ev.name === 'home') list.first()
    else if (ev.name === 'end') list.last()
    // j/k only when there is no filter to type into — otherwise they are text.
    else if (!filterable && ev.name === 'j') list.move(1)
    else if (!filterable && ev.name === 'k') list.move(-1)
    else if (!filterable && ev.name === 'G') list.last()
    else if (filterable) {
      if (ev.name === 'backspace') { filter = filter.slice(0, -1); refresh() }
      else if (isPrintable(ev)) { filter += ev.ch; refresh() }
    }
  }
  })
}

// Scrollable read-only text, used for help and for showing diffs before a write.
//
// `lines` may mix plain strings and { text, style } spans — help does exactly
// that — so they are normalised once up front rather than type-tested per
// frame.
export async function showText(app, { title, lines, style = S.base }) {
  const { screen: scr, kb } = app

  const rows = (Array.isArray(lines) ? lines : [lines]).map((l) => {
    if (l && typeof l === 'object' && !Array.isArray(l)) {
      return { text: asText(l.text), style: l.style ?? style }
    }
    return { text: asText(l), style }
  })

  // reduce, not Math.max(...rows): spreading a whole file's worth of lines as
  // arguments overflows the call stack.
  const widest = rows.reduce((m, r) => Math.max(m, stringWidth(r.text)), 0)

  let offset = 0
  return overlay(app, async () => {
    for (;;) {
      app.renderBase()
      const w = Math.max(24, Math.min(scr.cols - 4, Math.max(50, widest) + 6))
      const h = Math.max(6, Math.min(scr.rows - 4, rows.length + 4))
      const [x, y] = panel(scr, w, h)
      const bodyH = h - 3
      const maxOff = Math.max(0, rows.length - bodyH)
      offset = Math.max(0, Math.min(offset, maxOff))
      scr.box(x, y, w, h, {
        title, focused: true,
        hint: maxOff ? `${offset + 1}-${Math.min(offset + bodyH, rows.length)} of ${rows.length}` : '',
      })

      for (let i = 0; i < bodyH; i++) {
        const row = rows[offset + i]
        if (row === undefined) break
        scr.put(x + 2, y + 1 + i, truncate(row.text, w - 4), row.style)
      }
      scr.put(x + 2, y + h - 2, maxOff ? '↑↓ scroll   esc close' : 'esc close', S.dim)
      scr.flush()

      const ev = await kb.next()
      if (ev.name === 'escape' || ev.name === 'q' || ev.name === 'enter') return
      if (ev.name === 'up' || ev.name === 'k') offset--
      else if (ev.name === 'down' || ev.name === 'j') offset++
      else if (ev.name === 'pageup') offset -= bodyH
      else if (ev.name === 'pagedown' || ev.name === 'space') offset += bodyH
      else if (ev.name === 'home' || ev.name === 'g') offset = 0
      else if (ev.name === 'end' || ev.name === 'G') offset = maxOff
    }
  })
}
