// Defaults — the scalar settings.
//
// Full width, no preview pane: every row is an enum, a toggle, or a short
// string. Keys cl does not recognise still appear, under "Other", so nothing
// in the file is hidden from you.

import { S } from '../../tui/theme.mjs'
import { promptText, checkbox } from '../../tui/widgets.mjs'
import { truncate, fit, wrap } from '../../tui/width.mjs'
import * as Settings from '../../data/settings.mjs'
import { Editor } from './base.mjs'

const LABEL_W = 22

export class DefaultsEditor extends Editor {
  keys = [['space', 'toggle'], ['h/l', 'change'], ['enter', 'edit'], ['x', 'unset'], ['esc', 'back']]
  help = [
    'space        toggle a boolean, or cycle an enum',
    'h / l  ← →   change an enum value',
    'enter        edit a string or number',
    'x            remove the key entirely, restoring Claude\'s own default',
    '',
    'Keys cl does not know about are listed under Other and stay editable.',
    'A dash means the key is absent from the file.',
  ]

  constructor(scope) {
    super(scope)
    this.row = 0
    this.offset = 0
  }

  // [{ kind: 'header' } | { kind: 'field', def }]
  rows() {
    const defs = Settings.defaultsRows(this.data)
    const groups = []
    for (const def of defs) {
      let g = groups.find((x) => x.label === def.group)
      if (!g) { g = { label: def.group, items: [] }; groups.push(g) }
      g.items.push(def)
    }
    const out = []
    for (const g of groups) {
      out.push({ kind: 'header', label: g.label })
      for (const def of g.items) out.push({ kind: 'field', def })
    }
    return out
  }

  move(delta) {
    const rows = this.rows()
    if (!rows.length) return
    let i = this.row
    for (let n = 0; n < rows.length; n++) {
      i += delta
      if (i < 0) i = rows.length - 1
      if (i >= rows.length) i = 0
      if (rows[i].kind === 'field') { this.row = i; return }
    }
  }

  currentDef() {
    const rows = this.rows()
    const row = rows[this.row]
    return row?.kind === 'field' ? row.def : null
  }

  async onMouse(m, app) {
    const vp = this.viewport
    if (!vp) return false
    if (m.wheel) { this.move(m.wheel === 'up' ? -1 : 1); return true }
    if (!m.press || m.button !== 0) return false
    if (m.y < vp.y || m.y >= vp.y + vp.h) return false
    const i = this.offset + (m.y - vp.y)
    const rows = this.rows()
    if (rows[i]?.kind !== 'field') return false
    const again = this.row === i
    this.row = i
    // Clicking a selected boolean or enum cycles it; anything else opens the
    // editor, matching what enter does.
    if (again) await this.onKey({ name: 'space', ch: ' ', ctrl: false, alt: false, shift: false }, app)
    return true
  }

  render(app, body) {
    const scr = app.screen
    const rows = this.rows()
    if (rows[this.row]?.kind !== 'field') this.move(1)

    const descH = 3
    const listH = Math.max(1, body.h - descH)
    if (this.row < this.offset) this.offset = this.row
    if (this.row >= this.offset + listH) this.offset = this.row - listH + 1
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - listH)))
    this.viewport = { y: body.y, h: listH }

    for (let vi = 0; vi < listH; vi++) {
      const i = this.offset + vi
      const row = rows[i]
      if (!row) break
      const y = body.y + vi

      if (row.kind === 'header') {
        scr.put(body.x + 1, y, row.label.toUpperCase(), S.heading)
        continue
      }

      const def = row.def
      const selected = i === this.row
      if (selected) scr.fill(body.x, y, body.w, 1, ' ', S.sel)

      const labelStyle = selected ? S.accent : (def.present ? S.muted : S.dim)
      scr.put(body.x + 3, y, fit(def.label, LABEL_W), labelStyle)

      const vx = body.x + 3 + LABEL_W + 1
      const vw = body.w - (vx - body.x) - 12
      this.renderValue(scr, vx, y, vw, def, selected)

      if (!def.present) {
        const hint = 'unset'
        const hx = body.x + body.w - 2 - hint.length
        if (hx > vx + vw) scr.put(hx, y, hint, S.dim)
      }
      if (def.unknown) {
        const hx = body.x + body.w - 2 - 7
        if (hx > vx + vw) scr.put(hx, y, 'unknown', S.warn)
      }
    }

    const y = body.y + listH
    scr.hline(body.x, y, body.w, S.border)
    const def = this.currentDef()
    wrap(def?.desc ?? '', body.w - 4).slice(0, 2)
      .forEach((l, k) => scr.put(body.x + 2, y + 1 + k, l, S.warn))
  }

  renderValue(scr, x, y, w, def, selected) {
    if (!def.present || def.value === undefined) {
      scr.put(x, y, '—', S.dim)
      return
    }
    if (def.type === 'bool') {
      const on = def.value === true
      scr.put(x, y, `${checkbox(on)} ${on ? 'on' : 'off'}`, on ? (selected ? S.title : S.ok) : S.dim)
      return
    }
    if (def.type === 'enum') {
      let cx = x
      for (const opt of def.options) {
        const on = opt === def.value
        const text = (on ? '▸' : ' ') + opt
        if (cx + text.length + 1 > x + w) break
        cx = scr.put(cx, y, text, on ? (selected ? S.title : S.accent) : (selected ? S.muted : S.dim))
        cx = scr.put(cx, y, ' ', S.base)
      }
      return
    }
    const text = typeof def.value === 'object' ? JSON.stringify(def.value) : String(def.value)
    scr.put(x, y, truncate(text, w), selected ? S.title : S.base)
  }

  async onKey(ev, app) {
    const rows = this.rows()

    switch (ev.name) {
      case 'up': this.move(-1); return true
      case 'down': this.move(1); return true
      case 'home': this.row = 0; this.move(1); return true
      case 'end': this.row = rows.length - 1; this.move(-1); return true
    }

    const def = this.currentDef()
    if (!def) return false

    const cycle = async (dir) => {
      const opts = def.options
      const i = opts.indexOf(def.value)
      const next = i === -1 ? opts[dir > 0 ? 0 : opts.length - 1] : opts[(i + dir + opts.length) % opts.length]
      await this.apply(app, (d) => { d[def.key] = next }, `${def.key} = ${next}`)
    }

    if (ev.name === 'left' || ev.name === 'right') {
      const dir = ev.name === 'right' ? 1 : -1
      if (def.type === 'enum') { await cycle(dir); return true }
      if (def.type === 'bool') {
        await this.apply(app, (d) => { d[def.key] = !(def.value === true) }, null)
        return true
      }
      return true
    }

    if (ev.name === 'space') {
      if (def.type === 'bool') {
        const next = !(def.value === true)
        await this.apply(app, (d) => { d[def.key] = next }, `${def.key} ${next ? 'on' : 'off'}`)
        return true
      }
      if (def.type === 'enum') { await cycle(1); return true }
      return true
    }

    if (ev.name === 'enter') {
      if (def.type === 'bool' || def.type === 'enum') return true
      const isNum = def.type === 'number'
      const value = await promptText(app, {
        title: def.label,
        label: def.desc,
        value: def.value === undefined || def.value === null ? '' : String(def.value),
        placeholder: 'empty to unset',
        validate: (v) => (!isNum || v === '' || /^-?\d+(\.\d+)?$/.test(v) ? null : 'numbers only'),
      })
      if (value === null) return true
      await this.apply(app, (d) => {
        if (value === '') delete d[def.key]
        else d[def.key] = isNum ? Number(value) : value
      }, value === '' ? `${def.key} unset` : `${def.key} = ${value}`)
      return true
    }

    if (ev.name === 'x') {
      if (!def.present) { app.toast('already unset'); return true }
      await this.apply(app, (d) => { delete d[def.key] }, `${def.key} unset`)
      return true
    }
    return false
  }
}
