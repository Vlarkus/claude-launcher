// Back-buffer terminal renderer.
//
// Screens draw into a cell grid; flush() emits only the cells that changed
// since the last frame. This is what removes the flicker of the old launcher,
// which called Console::Clear() on every keypress.
//
// A cell is { c, s }: one character and its SGR parameter string. Wide
// characters occupy their cell and mark the next one as a continuation (c is
// null) so the diff never splits them.

import { charWidth, stringWidth, fit, truncate } from './width.mjs'
import { S } from './theme.mjs'

const CSI = '\x1b['

export const BORDER = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼',
}

export class Screen {
  constructor(out = process.stdout) {
    this.out = out
    this.cols = 0
    this.rows = 0
    this.cur = []
    this.prev = []
    this.entered = false
    // Off in a pipe: the escape codes would be written into whatever is
    // capturing the output.
    this.mouse = out.isTTY !== false
    this._resizeHandler = () => {
      this.#measure()
      this.prev = [] // force a full repaint
      if (this.onResize) this.onResize()
    }
    this.#measure()
  }

  #measure() {
    this.cols = Math.max(20, this.out.columns || 80)
    this.rows = Math.max(8, this.out.rows || 24)
  }

  // 1000 reports button presses and the wheel; 1006 asks for the SGR encoding,
  // which is the only one that survives past column 223. Both are turned off on
  // the way out so the terminal is not left emitting escape codes.
  enter() {
    if (this.entered) return
    this.entered = true
    this.out.write(CSI + '?1049h' + CSI + '?25l' + CSI + '2J' + CSI + 'H')
    if (this.mouse) this.out.write(CSI + '?1000h' + CSI + '?1006h')
    this.out.on('resize', this._resizeHandler)
  }

  leave() {
    if (!this.entered) return
    this.entered = false
    this.out.removeListener('resize', this._resizeHandler)
    if (this.mouse) this.out.write(CSI + '?1006l' + CSI + '?1000l')
    this.out.write(CSI + '0m' + CSI + '?25h' + CSI + '?1049l')
  }

  // Start a new frame. Everything is blank until drawn.
  begin() {
    this.#measure()
    const n = this.cols * this.rows
    this.cur = new Array(n)
    for (let i = 0; i < n; i++) this.cur[i] = BLANK
  }

  #idx(x, y) {
    return y * this.cols + x
  }

  // Write `text` at (x, y). Clips at the screen edges.
  put(x, y, text, style = S.base) {
    if (y < 0 || y >= this.rows) return x
    let cx = x
    for (const ch of String(text)) {
      const w = charWidth(ch.codePointAt(0))
      if (w === 0) continue
      if (cx >= this.cols) break
      if (cx >= 0) {
        this.cur[this.#idx(cx, y)] = { c: ch, s: style }
        if (w === 2 && cx + 1 < this.cols) {
          this.cur[this.#idx(cx + 1, y)] = { c: null, s: style }
        }
      }
      cx += w
    }
    return cx
  }

  // Fill a rectangle with `ch`.
  fill(x, y, w, h, ch = ' ', style = S.base) {
    for (let j = 0; j < h; j++) {
      const row = y + j
      if (row < 0 || row >= this.rows) continue
      for (let i = 0; i < w; i++) {
        const col = x + i
        if (col < 0 || col >= this.cols) continue
        this.cur[this.#idx(col, row)] = { c: ch, s: style }
      }
    }
  }

  // Draw text padded to `w` cells — used for selected rows so the highlight
  // runs to the pane edge rather than stopping at the text.
  putRow(x, y, w, text, style = S.base, align = 'left') {
    this.put(x, y, fit(text, w, align), style)
  }

  hline(x, y, w, style = S.border, ch = BORDER.h) {
    this.put(x, y, ch.repeat(Math.max(0, w)), style)
  }

  vline(x, y, h, style = S.border, ch = BORDER.v) {
    for (let j = 0; j < h; j++) this.put(x, y + j, ch, style)
  }

  // Box with an optional title in the top border. `focused` brightens it.
  box(x, y, w, h, { title = '', focused = false, style = null, hint = '' } = {}) {
    if (w < 2 || h < 2) return
    const st = style || (focused ? S.borderOn : S.border)
    this.put(x, y, BORDER.tl, st)
    this.hline(x + 1, y, w - 2, st)
    this.put(x + w - 1, y, BORDER.tr, st)
    for (let j = 1; j < h - 1; j++) {
      this.put(x, y + j, BORDER.v, st)
      this.put(x + w - 1, y + j, BORDER.v, st)
    }
    this.put(x, y + h - 1, BORDER.bl, st)
    this.hline(x + 1, y + h - 1, w - 2, st)
    this.put(x + w - 1, y + h - 1, BORDER.br, st)

    if (title) {
      const t = truncate(' ' + title + ' ', Math.max(0, w - 4))
      this.put(x + 2, y, t, focused ? S.title : S.heading)
    }
    if (hint) {
      const t = truncate(' ' + hint + ' ', Math.max(0, w - 4))
      const hx = x + w - 2 - stringWidth(t)
      if (hx > x + 1) this.put(hx, y + h - 1, t, S.dim)
    }
  }

  // Emit the diff between this frame and the last.
  flush() {
    const out = []
    let lastStyle = null
    const full = this.prev.length !== this.cur.length

    for (let y = 0; y < this.rows; y++) {
      const base = y * this.cols
      // Bound the changed span on this row.
      let first = -1
      let last = -1
      for (let x = 0; x < this.cols; x++) {
        const i = base + x
        const a = this.cur[i]
        const b = full ? null : this.prev[i]
        if (!b || a.c !== b.c || a.s !== b.s) {
          if (first === -1) first = x
          last = x
        }
      }
      if (first === -1) continue

      // Never begin mid-way through a wide character.
      while (first > 0 && this.cur[base + first].c === null) first--

      out.push(CSI + (y + 1) + ';' + (first + 1) + 'H')
      for (let x = first; x <= last; x++) {
        const cell = this.cur[base + x]
        if (cell.c === null) continue // continuation of a wide char
        if (cell.s !== lastStyle) {
          out.push(CSI + '0m')
          if (cell.s) out.push(CSI + cell.s + 'm')
          lastStyle = cell.s
        }
        out.push(cell.c)
      }
    }

    if (out.length) {
      out.push(CSI + '0m')
      this.out.write(out.join(''))
    }
    this.prev = this.cur
  }

  // Repaint everything on the next flush.
  invalidate() {
    this.prev = []
  }
}

const BLANK = Object.freeze({ c: ' ', s: S.base })

export { stringWidth, truncate, fit }
