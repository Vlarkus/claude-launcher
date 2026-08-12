// Directory picker.
//
// Two modes in one overlay, because choosing a directory is really two jobs:
//
//   list    the directories cl already knows you work in, newest first. Zero
//           filesystem walk, and it covers almost every launch.
//   browse  Miller columns — parent | here | preview — for finding somewhere
//           new, and for creating a directory, which is inherently spatial:
//           you have to *be* somewhere to make a new one there.
//
// A flat fuzzy list has no "here", which is why creation lives in browse.
//
// Typing in list mode filters. Typing a path (~, /, C:) turns the filter into
// path entry with completion, so someone who knows the path never has to
// navigate at all.

import { S } from './theme.mjs'
import { BORDER } from './screen.mjs'
import { truncate, fit, stringWidth } from './width.mjs'
import { isPrintable } from './keys.mjs'
import { overlay } from './widgets.mjs'
import { tildify, exists, formatAge, HOME } from '../data/paths.mjs'
import * as D from '../data/dirs.mjs'

const looksLikePath = (s) => /^(~|\/|\\|[A-Za-z]:)/.test(s)

// Where a path-shaped filter splits into "directory to list" and "prefix to
// match": everything up to the last separator, and everything after it.
function splitPath(text) {
  const s = text.replace(/\\/g, '/')
  const cut = s.lastIndexOf('/')
  if (cut < 0) return { dir: null, tail: s }
  return { dir: D.normalize(s.slice(0, cut + 1)) || '/', tail: s.slice(cut + 1) }
}

export async function pickDirectory(app, { title = 'Directory', value = null } = {}) {
  const start = D.normalize(value && exists(value) ? value : process.cwd())

  const st = {
    mode: 'list',            // 'list' | 'browse'
    filter: '',
    listCursor: 0,
    listOffset: 0,
    cwd: D.normalize(D.parentOf(start) || start), // the middle column
    cursor: 0,
    offset: 0,
    hidden: false,
    error: null,
  }

  // Open browse with the starting directory highlighted, not just its parent.
  const seed = () => {
    const rows = D.listDirs(st.cwd, { hidden: st.hidden })
    const i = rows.findIndex((r) => r.path === start)
    st.cursor = i >= 0 ? i : 0
  }
  seed()

  const known = D.knownDirs()

  // Open on the directory already configured, if cl knows it. Without this the
  // list opens on whatever is most recent and `tab` would browse from there
  // rather than from where you actually are.
  {
    const i = known.findIndex((k) => k.path === start)
    if (i >= 0) st.listCursor = i
  }

  // ── list mode data ───────────────────────────────────────────────
  const listRows = () => {
    const f = st.filter.trim()
    if (f && looksLikePath(f)) {
      const { dir, tail } = splitPath(f)
      if (!dir) return []
      const low = tail.toLowerCase()
      return D.listDirs(dir, { hidden: st.hidden || tail.startsWith('.') })
        .filter((r) => r.name.toLowerCase().startsWith(low))
        .map((r) => ({ path: r.path, name: r.name, kind: 'fs' }))
    }
    const low = f.toLowerCase()
    return known
      .filter((k) => !low || k.path.toLowerCase().includes(low) || k.name.toLowerCase().includes(low))
      .map((k) => ({ ...k, kind: 'known' }))
  }

  const clampList = (rows) => {
    st.listCursor = Math.max(0, Math.min(st.listCursor, rows.length - 1))
    if (rows.length === 0) st.listCursor = 0
  }

  // ── browse mode data ─────────────────────────────────────────────
  // Windows has no single filesystem root, so the level above C:/ is a
  // synthetic list of drives. The leading space keeps it from colliding with
  // any real path.
  const DRIVES = ' drives'
  const atDrives = () => st.cwd === DRIVES
  const rowsFor = (dir) => (dir === DRIVES
    ? D.drives().map((d) => ({ name: d.name, path: d.path }))
    : D.listDirs(dir, { hidden: st.hidden }))

  const hereRows = () => rowsFor(st.cwd)
  const selected = () => hereRows()[st.cursor] || null

  const goTo = (dir, { keep = null } = {}) => {
    st.cwd = dir === DRIVES ? DRIVES : D.normalize(dir)
    const rows = hereRows()
    const i = keep ? rows.findIndex((r) => r.path === D.normalize(keep)) : -1
    st.cursor = i >= 0 ? i : 0
    st.offset = 0
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

  const chosenPath = () => {
    if (st.mode === 'list') {
      const rows = listRows()
      return rows[st.listCursor]?.path ?? null
    }
    const s = selected()
    if (s) return s.path
    return atDrives() ? null : st.cwd  // an empty directory chooses itself
  }

  return overlay(app, async () => {
    for (;;) {
      app.renderBase()
      draw()
      app.screen.flush()

      const ev = await app.kb.next()
      st.error = null

      if (ev.name === 'escape') return null
      if (ev.name === 'enter') {
        const p = chosenPath()
        if (!p) { st.error = 'nothing selected'; continue }
        if (!exists(p)) { st.error = 'that directory no longer exists'; continue }
        return p
      }
      if (ev.ctrl && ev.name === 'b') { toggleMode(); continue }
      if (ev.name === 'tab') { toggleMode(); continue }

      if (st.mode === 'list') await listKey(ev)
      else await browseKey(ev)
    }
  })

  // tab only swaps the view; browse stays wherever it already was, seeded from
  // the directory you came in with. Stepping into a *highlighted* row is the
  // separate, explicit → action, so the two never fight over "where am I".
  function toggleMode() {
    st.mode = st.mode === 'list' ? 'browse' : 'list'
  }

  // ── keys ─────────────────────────────────────────────────────────
  async function listKey(ev) {
    const rows = listRows()
    if (ev.name === 'up' || (ev.ctrl && ev.name === 'p')) { st.listCursor--; clampList(rows); return }
    if (ev.name === 'down' || (ev.ctrl && ev.name === 'n')) { st.listCursor++; clampList(rows); return }
    if (ev.name === 'pageup') { st.listCursor -= 10; clampList(rows); return }
    if (ev.name === 'pagedown') { st.listCursor += 10; clampList(rows); return }
    if (ev.name === 'home') { st.listCursor = 0; return }
    if (ev.name === 'end') { st.listCursor = rows.length - 1; clampList(rows); return }
    // Right steps into the highlighted directory, which is also how you get
    // from "I know this project" to "…but I want something next to it".
    if (ev.name === 'right') {
      const p = rows[st.listCursor]?.path
      if (p) { st.mode = 'browse'; goTo(p) }
      return
    }
    if (ev.name === 'backspace') {
      st.filter = st.filter.slice(0, -1)
      st.listCursor = 0
      return
    }
    if (ev.ctrl && ev.name === 'u') { st.filter = ''; st.listCursor = 0; return }
    // Tab-style completion when the filter is a path.
    if (ev.name === 'space' && looksLikePath(st.filter)) return
    if (isPrintable(ev)) { st.filter += ev.ch; st.listCursor = 0; return }
  }

  async function browseKey(ev) {
    const rows = hereRows()
    switch (ev.name) {
      case 'up': case 'k': st.cursor = Math.max(0, st.cursor - 1); return
      case 'down': case 'j': st.cursor = Math.min(Math.max(0, rows.length - 1), st.cursor + 1); return
      case 'pageup': st.cursor = Math.max(0, st.cursor - 10); return
      case 'pagedown': st.cursor = Math.min(Math.max(0, rows.length - 1), st.cursor + 10); return
      case 'home': st.cursor = 0; return
      case 'end': st.cursor = Math.max(0, rows.length - 1); return
      case 'left': case 'h': {
        if (atDrives()) return
        ascend(); return
      }
      case 'right': case 'l': {
        if (atDrives()) { const d = selected(); if (d) goTo(d.path); return }
        descend(); return
      }
      case 'g': st.cursor = 0; return
      case 'G': st.cursor = Math.max(0, rows.length - 1); return
      case '.': st.hidden = !st.hidden; clamp(); return
      case '~': goTo(D.normalize(HOME)); return
      case 'a': await create(); return
      case '/': st.mode = 'list'; st.filter = tildify(st.cwd) + '/'; st.listCursor = 0; return
    }
  }

  async function create() {
    if (atDrives()) { st.error = 'pick a drive first'; return }
    const { promptText } = await import('./widgets.mjs')
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
    try {
      const made = D.createDir(st.cwd, name)
      goTo(st.cwd, { keep: made })
      app.toast(`created ${tildify(made)}`)
    } catch (err) {
      st.error = err.message
    }
  }

  // ── drawing ──────────────────────────────────────────────────────
  // A full-width rule that meets the frame, rather than stopping one cell
  // short of it on each side.
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

    // Header: the filter in list mode, the breadcrumb in browse.
    const hy = y + 1
    if (st.mode === 'list') {
      scr.put(x + 2, hy, '> ', S.accent)
      const shown = st.filter || 'type to filter · a path to jump'
      scr.put(x + 4, hy, truncate(shown, w - 24), st.filter ? S.title : S.dim)
      if (st.filter) scr.put(x + 4 + stringWidth(st.filter), hy, ' ', S.selOn)
      const rows = listRows()
      const count = looksLikePath(st.filter.trim()) ? `${rows.length} here` : `${rows.length} / ${known.length} known`
      scr.put(x + w - 2 - stringWidth(count), hy, count, S.dim)
    } else {
      const crumb = atDrives() ? 'drives' : tildify(st.cwd)
      scr.put(x + 2, hy, truncate(crumb, w - 4), S.title)
    }
    rule(scr, x, y + 2, w)

    // Rows y+3 … y+h-4: the frame takes the top two lines and the rule, and
    // the footer takes a rule plus a line. Getting this one short would let the
    // footer rule paint over the last row — which silently hides the final
    // entry in every column and the "N more" hint with it.
    const bodyY = y + 3
    const bodyH = h - 6
    if (st.mode === 'list') drawList(scr, x + 1, bodyY, w - 2, bodyH)
    else drawBrowse(scr, x + 1, bodyY, w - 2, bodyH)

    // Footer.
    const fy = y + h - 2
    rule(scr, x, fy - 1, w)
    const keys = st.mode === 'list'
      ? '↑↓ move   → browse here   tab browse   enter choose   esc cancel'
      : 'h l out/in   j k move   a new dir   . hidden   ~ home   / path   enter choose'
    scr.put(x + 2, fy, truncate(st.error || keys, w - 4), st.error ? S.err : S.dim)
  }

  function drawList(scr, x, y, w, h) {
    const rows = listRows()
    if (!rows.length) {
      scr.put(x + 2, y + 1, st.filter ? 'nothing matches' : 'no known directories yet', S.dim)
      scr.put(x + 2, y + 3, 'tab  browse the filesystem instead', S.dim)
      return
    }
    if (st.listCursor < st.listOffset) st.listOffset = st.listCursor
    if (st.listCursor >= st.listOffset + h) st.listOffset = st.listCursor - h + 1
    st.listOffset = Math.max(0, Math.min(st.listOffset, Math.max(0, rows.length - h)))

    for (let i = 0; i < h && st.listOffset + i < rows.length; i++) {
      const r = rows[st.listOffset + i]
      const on = st.listOffset + i === st.listCursor
      const ry = y + i
      if (on) scr.fill(x, ry, w, 1, ' ', S.sel)

      const nameW = Math.min(28, Math.floor(w * 0.3))
      const gone = r.kind === 'known' && !r.exists
      scr.put(x + 1, ry, on ? '▸' : ' ', S.accent)
      scr.put(x + 3, ry, fit(r.name, nameW), gone ? S.err : (on ? S.title : S.base))

      const parent = tildify(D.parentOf(r.path) || r.path)
      const restX = x + 3 + nameW + 1
      const metaW = r.kind === 'known' ? 22 : 0
      scr.put(restX, ry, fit(truncate(parent, w - nameW - metaW - 6), w - nameW - metaW - 6), S.muted)

      if (r.kind === 'known') {
        const g = r.exists ? D.gitInfo(r.path) : { repo: false }
        const bits = []
        if (r.newest) bits.push(formatAge(r.newest))
        if (r.sessions) bits.push(`${r.sessions}`)
        const meta = gone ? 'missing' : bits.join('  ')
        scr.put(x + w - 2 - stringWidth(meta), ry, meta, gone ? S.err : S.dim)
        if (g.branch && w > 70) {
          const b = truncate(g.branch, 10)
          scr.put(x + w - 4 - stringWidth(meta) - stringWidth(b), ry, b, S.ok)
        }
      }
    }
  }

  function drawBrowse(scr, x, y, w, h) {
    // parent | here | preview
    const lw = Math.max(12, Math.floor(w * 0.22))
    const mw = Math.max(16, Math.floor(w * 0.36))
    const rw = w - lw - mw - 2
    const mx = x + lw + 1
    const rx = mx + mw + 1

    scr.vline(x + lw, y, h, S.border)
    scr.vline(mx + mw, y, h, S.border)

    // Parent column.
    const up = atDrives() ? null : D.parentOf(st.cwd)
    const parentRows = up ? rowsFor(up) : (atDrives() ? [] : D.drives())
    const parentSel = atDrives() ? -1 : parentRows.findIndex((r) => r.path === st.cwd)
    drawColumn(scr, x, y, lw, h, parentRows, parentSel, false)

    // Here.
    const rows = hereRows()
    clampInto(rows.length, h)
    if (!rows.length) {
      scr.put(mx + 1, y, D.isDenied(st.cwd, { hidden: st.hidden }) ? 'permission denied' : 'no subdirectories', S.dim)
      scr.put(mx + 1, y + 2, 'enter chooses this directory', S.muted)
    } else {
      drawColumn(scr, mx, y, mw, h, rows, st.cursor, true, st.offset)
    }

    // Preview of the highlighted directory.
    const sel = selected()
    drawPreview(scr, rx, y, rw, h, sel ? sel.path : st.cwd)
  }

  function clampInto(n, h) {
    st.cursor = n ? Math.max(0, Math.min(st.cursor, n - 1)) : 0
    if (st.cursor < st.offset) st.offset = st.cursor
    if (st.cursor >= st.offset + h) st.offset = st.cursor - h + 1
    st.offset = Math.max(0, Math.min(st.offset, Math.max(0, n - h)))
  }

  function drawColumn(scr, x, y, w, h, rows, cursor, active, offset = 0) {
    if (cursor >= 0 && !active) offset = Math.max(0, Math.min(cursor - Math.floor(h / 2), Math.max(0, rows.length - h)))
    for (let i = 0; i < h && offset + i < rows.length; i++) {
      const r = rows[offset + i]
      const on = offset + i === cursor
      const ry = y + i
      if (on && active) scr.fill(x, ry, w, 1, ' ', S.sel)
      const style = on ? (active ? S.title : S.accent) : (active ? S.base : S.muted)
      scr.put(x + 1, ry, truncate(r.name, w - 2), style)
    }
    if (rows.length > offset + h) {
      scr.put(x + 1, y + h - 1, truncate(`… ${rows.length - offset - h + 1} more`, w - 2), S.dim)
    }
  }

  function drawPreview(scr, x, y, w, h, dir) {
    if (!dir || w < 12) return
    let cy = y
    const g = D.gitInfo(dir)
    if (g.repo) {
      scr.put(x + 1, cy, '● git', S.ok)
      if (g.branch) scr.put(x + 7, cy, truncate(g.branch, w - 9), S.base)
      cy++
    }
    const k = known.find((n) => n.path === D.normalize(dir))
    if (k) {
      scr.put(x + 1, cy, `${k.sessions} session${k.sessions === 1 ? '' : 's'}`, S.muted)
      if (k.newest) scr.put(x + 1 + 14, cy, `last ${formatAge(k.newest)}`, S.dim)
      cy++
    }
    if (cy > y) cy++

    const kids = D.listDirs(dir, { hidden: st.hidden })
    if (!kids.length) {
      scr.put(x + 1, cy, D.isDenied(dir, { hidden: st.hidden }) ? 'permission denied' : 'empty', S.dim)
      return
    }
    for (let i = 0; i < Math.min(kids.length, y + h - cy - 1); i++) {
      scr.put(x + 1, cy, truncate(kids[i].name, w - 2), S.muted)
      cy++
      if (cy >= y + h - 1) break
    }
    if (kids.length > y + h - cy) {
      scr.put(x + 1, Math.min(cy, y + h - 1), `… ${kids.length} total`, S.dim)
    }
  }
}
