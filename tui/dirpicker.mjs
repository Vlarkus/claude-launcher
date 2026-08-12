// Directory picker — Miller columns, as in ranger, yazi and lf.
//
//   parent │ here │ preview
//
// It always opens on the directory cl was started in, with that directory
// highlighted inside its parent, so `enter` picks where you already are and
// h/l walk out and in from there.
//
// `a` creates a directory in the column you are standing in. Creation belongs
// here rather than in a flat list because making a directory is spatial: you
// have to *be* somewhere to make a new one there.

import { S } from './theme.mjs'
import { BORDER } from './screen.mjs'
import { truncate, stringWidth } from './width.mjs'
import { isPrintable } from './keys.mjs'
import { overlay, promptText } from './widgets.mjs'
import { tildify, exists, HOME } from '../data/paths.mjs'
import * as D from '../data/dirs.mjs'

// Not a path: the level above a drive root, where Windows has no single
// filesystem root to show. The leading space keeps it from colliding with
// anything real.
const DRIVES = ' drives'

export async function pickDirectory(app, { title = 'Directory', value = null } = {}) {
  // Where cl was started, unless a caller explicitly passes somewhere else.
  const start = D.normalize(value && exists(value) ? value : process.cwd())

  const st = {
    cwd: D.normalize(D.parentOf(start) || start),
    cursor: 0,
    offset: 0,
    hidden: false,
    filter: '',
    filtering: false,
    error: null,
  }

  const atDrives = () => st.cwd === DRIVES

  const allRows = (dir) => (dir === DRIVES
    ? D.drives().map((d) => ({ name: d.name, path: d.path }))
    : D.listDirs(dir, { hidden: st.hidden }))

  // The filter narrows the middle column only; the parent column keeps its
  // full contents so you never lose your bearings.
  const rows = () => {
    const all = allRows(st.cwd)
    const f = st.filter.trim().toLowerCase()
    return f ? all.filter((r) => r.name.toLowerCase().includes(f)) : all
  }

  const selected = () => rows()[st.cursor] || null

  const goTo = (dir, { keep = null } = {}) => {
    st.cwd = dir === DRIVES ? DRIVES : D.normalize(dir)
    st.filter = ''
    st.filtering = false
    const list = rows()
    const i = keep ? list.findIndex((r) => r.path === D.normalize(keep)) : -1
    st.cursor = i >= 0 ? i : 0
    st.offset = 0
  }

  // Open with the starting directory highlighted among its siblings, so enter
  // immediately means "use where I am".
  goTo(st.cwd, { keep: start })

  const move = (delta) => {
    const n = rows().length
    if (!n) { st.cursor = 0; return }
    st.cursor = Math.max(0, Math.min(n - 1, st.cursor + delta))
  }

  const descend = () => {
    const s = selected()
    if (!s) return
    if (!D.listDirs(s.path, { hidden: st.hidden }).length && D.isDenied(s.path, { hidden: st.hidden })) {
      st.error = 'permission denied'
      return
    }
    goTo(s.path)
  }

  const ascend = () => {
    if (atDrives()) return
    const up = D.parentOf(st.cwd)
    // Above a drive root is the drive list, not nothing.
    if (up === null) { goTo(DRIVES, { keep: st.cwd }); return }
    goTo(up, { keep: st.cwd })
  }

  // An empty column has nothing to point at, so it chooses the directory you
  // are standing in — which is also how you pick a brand-new empty project.
  const chosenPath = () => {
    const s = selected()
    if (s) return s.path
    return atDrives() ? null : st.cwd
  }

  // Nothing below may take cl down: any failure becomes a message in the
  // picker's own footer.
  return overlay(app, async () => {
    for (;;) {
      try {
        app.renderBase()
        draw()
        app.screen.flush()
      } catch (err) {
        app.error(`picker draw failed: ${err.message}`)
        return null
      }

      const ev = await app.kb.next()
      st.error = null

      try {
        if (st.filtering) {
          if (ev.name === 'escape') { st.filter = ''; st.filtering = false; st.cursor = 0; continue }
          if (ev.name === 'enter') { st.filtering = false; continue }
          if (ev.name === 'backspace') { st.filter = st.filter.slice(0, -1); st.cursor = 0; continue }
          if (ev.name === 'up') { move(-1); continue }
          if (ev.name === 'down') { move(1); continue }
          if (ev.ctrl && ev.name === 'u') { st.filter = ''; st.cursor = 0; continue }
          if (ev.name === 'space') { st.filter += ' '; st.cursor = 0; continue }
          if (isPrintable(ev)) { st.filter += ev.ch; st.cursor = 0; continue }
          continue
        }

        if (ev.name === 'escape') {
          if (st.filter) { st.filter = ''; st.cursor = 0; continue }
          return null
        }
        if (ev.name === 'enter') {
          const p = chosenPath()
          if (!p) { st.error = 'pick a drive first'; continue }
          if (!exists(p)) { st.error = 'that directory no longer exists'; continue }
          return p
        }
        await key(ev)
      } catch (err) {
        // A throw here would otherwise unwind through the screen and out of
        // cl's key loop, taking the program with it.
        st.error = err.message || String(err)
      }
    }
  })

  async function key(ev) {
    switch (ev.name) {
      case 'up': case 'k': move(-1); return
      case 'down': case 'j': move(1); return
      case 'pageup': move(-10); return
      case 'pagedown': move(10); return
      case 'home': case 'g': st.cursor = 0; return
      case 'end': case 'G': st.cursor = Math.max(0, rows().length - 1); return
      case 'left': case 'h': ascend(); return
      case 'right': case 'l': descend(); return
      case '.': st.hidden = !st.hidden; st.cursor = 0; return
      case '~': goTo(D.normalize(HOME)); return
      case '/': st.filtering = true; return
      case 'a': await create(); return
    }
  }

  async function create() {
    if (atDrives()) { st.error = 'pick a drive first'; return }
    const name = await promptText(app, {
      title: 'New directory',
      label: `Created in ${tildify(st.cwd)}`,
      placeholder: 'name',
      validate: (v) => {
        if (!v) return 'a name is required'
        if (/[\\/]/.test(v)) return 'no path separators'
        if (exists(D.normalize(st.cwd + '/' + v))) return 'already exists'
        return null
      },
    })
    if (!name) return
    const made = D.createDir(st.cwd, name)
    goTo(st.cwd, { keep: made })
    app.toast(`created ${tildify(made)}`)
  }

  // ── drawing ──────────────────────────────────────────────────────
  function rule(scr, x, y, w) {
    scr.hline(x + 1, y, w - 2, S.border)
    scr.put(x, y, BORDER.lt, S.border)
    scr.put(x + w - 1, y, BORDER.rt, S.border)
  }

  function draw() {
    const scr = app.screen
    const w = Math.min(scr.cols - 4, 96)
    const h = Math.min(scr.rows - 4, 24)
    const x = Math.max(0, Math.floor((scr.cols - w) / 2))
    const y = Math.max(1, Math.floor((scr.rows - h) / 2))
    scr.fill(x, y, w, h, ' ', S.base)
    scr.box(x, y, w, h, { title, focused: true })

    // Breadcrumb, or the filter while one is being typed.
    const hy = y + 1
    if (st.filtering || st.filter) {
      scr.put(x + 2, hy, '/ ', S.accent)
      scr.put(x + 4, hy, st.filter || '…', st.filter ? S.title : S.dim)
      if (st.filtering) scr.put(x + 4 + stringWidth(st.filter), hy, ' ', S.selOn)
      const n = `${rows().length}`
      scr.put(x + w - 2 - stringWidth(n), hy, n, S.dim)
    } else {
      scr.put(x + 2, hy, truncate(atDrives() ? 'drives' : tildify(st.cwd), w - 4), S.title)
    }
    rule(scr, x, y + 2, w)

    // Rows y+3 … y+h-4. One short here and the footer rule paints over the
    // last row of every column, hiding the final entry.
    drawColumns(scr, x + 1, y + 3, w - 2, h - 6)

    const fy = y + h - 2
    rule(scr, x, fy - 1, w)
    const keys = st.filtering
      ? 'type to narrow   ↑↓ move   enter keep   esc clear'
      : 'h l out/in   j k move   a new dir   / filter   . hidden   ~ home   enter choose   esc cancel'
    scr.put(x + 2, fy, truncate(st.error || keys, w - 4), st.error ? S.err : S.dim)
  }

  function drawColumns(scr, x, y, w, h) {
    if (h < 1) return
    const lw = Math.max(10, Math.floor(w * 0.24))
    const mw = Math.max(14, Math.floor(w * 0.38))
    const rw = w - lw - mw - 2
    const mx = x + lw + 1
    const rx = mx + mw + 1

    scr.vline(x + lw, y, h, S.border)
    if (rw > 2) scr.vline(mx + mw, y, h, S.border)

    // Parent.
    const up = atDrives() ? null : D.parentOf(st.cwd)
    const parentRows = up ? allRows(up) : (atDrives() ? [] : D.drives())
    const parentSel = atDrives() ? -1 : parentRows.findIndex((r) => r.path === st.cwd)
    drawColumn(scr, x, y, lw, h, parentRows, parentSel, false)

    // Here.
    const list = rows()
    if (!list.length) {
      const why = st.filter ? 'nothing matches' : D.isDenied(st.cwd, { hidden: st.hidden }) ? 'permission denied' : 'no subdirectories'
      scr.put(mx + 1, y, truncate(why, mw - 2), S.dim)
      if (!st.filter && !atDrives()) scr.put(mx + 1, y + 2, truncate('enter chooses this one', mw - 2), S.muted)
    } else {
      st.cursor = Math.max(0, Math.min(st.cursor, list.length - 1))
      if (st.cursor < st.offset) st.offset = st.cursor
      if (st.cursor >= st.offset + h) st.offset = st.cursor - h + 1
      st.offset = Math.max(0, Math.min(st.offset, Math.max(0, list.length - h)))
      drawColumn(scr, mx, y, mw, h, list, st.cursor, true, st.offset)
    }

    if (rw > 2) drawPreview(scr, rx, y, rw, h, selected()?.path ?? (atDrives() ? null : st.cwd))
  }

  function drawColumn(scr, x, y, w, h, list, cursor, active, offset = 0) {
    if (!active && cursor >= 0) {
      offset = Math.max(0, Math.min(cursor - Math.floor(h / 2), Math.max(0, list.length - h)))
    }
    for (let i = 0; i < h && offset + i < list.length; i++) {
      const r = list[offset + i]
      const on = offset + i === cursor
      const ry = y + i
      if (on && active) scr.fill(x, ry, w, 1, ' ', S.sel)
      const style = on ? (active ? S.title : S.accent) : (active ? S.base : S.muted)
      scr.put(x + 1, ry, truncate(r.name, w - 2), style)
    }
    if (list.length > offset + h) {
      scr.put(x + 1, y + h - 1, truncate(`… ${list.length - offset - h + 1} more`, w - 2), S.dim)
    }
  }

  function drawPreview(scr, x, y, w, h, dir) {
    if (!dir) return
    let cy = y
    const g = D.gitInfo(dir)
    if (g.repo) {
      scr.put(x + 1, cy, '● git', S.ok)
      if (g.branch) scr.put(x + 7, cy, truncate(g.branch, w - 9), S.base)
      cy += 2
    }
    const kids = D.listDirs(dir, { hidden: st.hidden })
    if (!kids.length) {
      scr.put(x + 1, cy, D.isDenied(dir, { hidden: st.hidden }) ? 'permission denied' : 'empty', S.dim)
      return
    }
    const room = y + h - cy - 1
    for (let i = 0; i < Math.min(kids.length, room); i++) {
      scr.put(x + 1, cy, truncate(kids[i].name, w - 2), S.muted)
      cy++
    }
    if (kids.length > room && cy <= y + h - 1) {
      scr.put(x + 1, cy, truncate(`… ${kids.length} total`, w - 2), S.dim)
    }
  }
}
