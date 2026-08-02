// Sessions — the landing screen and the fast lane.
//
// Left: every session grouped Live / Pinned / Recent. Right: detail for the
// highlighted one. Enter resumes, which is the whole point: two keystrokes
// from shell to conversation.

import path from 'node:path'
import { S, statusStyle, statusGlyph } from '../tui/theme.mjs'
import { List, confirm, promptText, listMouse } from '../tui/widgets.mjs'
import { truncate, fit, wrap, stringWidth } from '../tui/width.mjs'
import * as Sessions from '../data/sessions.mjs'
import * as State from '../data/state.mjs'
import { tildify, shortProject, formatBytes, formatAge, formatAgo, exists } from '../data/paths.mjs'
import { emptyConfig } from '../launch.mjs'
import { openFolder } from '../launch.mjs'

const HYDRATE_LIMIT = 120

export class SessionsScreen {
  id = 'sessions'
  title = 'Sessions'
  keys = [
    ['enter', 'resume'], ['n', 'new'], ['p', 'pin'], ['x', 'delete'],
    ['/', 'search'], ['r', 'refresh'], ['?', 'help'],
  ]
  help = [
    'enter        resume the highlighted session',
    'n            new session (opens Launch)',
    'c            continue most recent in this directory',
    'p            pin / unpin',
    'P            rename a pin',
    'x            delete the transcript',
    'o            open the project folder',
    '/            filter by title or project',
    'r            rescan sessions from disk',
  ]

  // While filtering, keys are text — the vim layer must not translate them.
  get textEntry() {
    return this.filtering
  }

  // Live rows carry a spinner, so redraw at animation rate while one is busy.
  animates = true

  constructor() {
    this.list = new List([])
    this.filter = ''
    this.filtering = false
    this.loaded = false
  }

  onEnter(app) {
    if (!this.loaded) this.reload(app)
  }

  onReturn(app) {
    this.reload(app)
  }

  reload(app) {
    this.loaded = true
    this.all = Sessions.listSessions({ limit: HYDRATE_LIMIT })
    this.live = app?.live ?? Sessions.listLive()
    State.reconcilePins(this.all)
    this.rebuild()
  }

  // Live status changes without a full rescan of every transcript.
  onTick(app) {
    const sig = Sessions.liveSignature(app.live ?? [])
    if (sig === this.liveSig) return false
    this.liveSig = sig
    this.live = app.live ?? []
    this.rebuild()
    return true
  }

  rebuild() {
    const st = State.loadState()
    const pinKeys = new Set(st.pins.map((p) => `${p.project}/${p.sessionId}`))
    const liveIds = new Map(this.live.map((l) => [l.id, l]))

    const f = this.filter.trim().toLowerCase()
    const match = (s) => {
      if (!f) return true
      const hay = [
        Sessions.displayTitle(s),
        shortProject(s.cwd) || s.project,
        s.cwd || '',
        s.id,
      ].join(' ').toLowerCase()
      return hay.includes(f)
    }

    // Hydration reads the transcript, so memoise it back into `this.all`.
    // Filtering rebuilds on every keystroke and would otherwise re-read every
    // session file each time.
    const hydrated = (s) => {
      if (s.hydrated) return s
      const h = Sessions.hydrate(s)
      const i = this.all.indexOf(s)
      if (i >= 0) this.all[i] = h
      return h
    }

    const isPinnedRow = (s) => pinKeys.has(`${s.project}/${s.id}`)

    // A session can be both live and pinned; live wins for placement.
    const liveRows = this.all.filter((s) => liveIds.has(s.id)).map(hydrated).filter(match)
    const pinnedRows = this.all
      .filter((s) => isPinnedRow(s) && !liveIds.has(s.id))
      .map(hydrated).filter(match)
    const recentRows = this.all
      .filter((s) => !liveIds.has(s.id) && !isPinnedRow(s))
      .map(hydrated).filter(match)

    const items = []
    const seen = new Set()
    const section = (label, list, kind) => {
      const rows = []
      for (const s of list) {
        if (seen.has(s.id)) continue
        seen.add(s.id)
        rows.push({
          id: s.id,
          kind: 'session',
          group: kind,
          session: s,
          live: liveIds.get(s.id) || null,
          pinned: isPinnedRow(s),
        })
      }
      if (!rows.length) return
      items.push({ id: `h:${kind}`, kind: 'header', label, count: rows.length, selectable: false })
      items.push(...rows)
    }
    section('LIVE', liveRows, 'live')
    section('PINNED', pinnedRows, 'pinned')
    section('RECENT', recentRows, 'recent')

    if (!items.length) {
      items.push({
        id: 'empty', kind: 'empty', selectable: false,
        label: f ? `no sessions match "${this.filter}"` : 'no sessions yet — press n to start one',
      })
    }
    this.list.setItems(items)
  }

  headerRight() {
    const n = this.all?.length ?? 0
    const live = this.live?.length ?? 0
    return `${live ? `● ${live} live · ` : ''}${n} sessions`
  }

  render(app, body) {
    const scr = app.screen
    const leftW = Math.max(34, Math.min(58, Math.floor(body.w * 0.46)))
    const rightX = body.x + leftW + 2
    const rightW = body.w - leftW - 3
    // The list stops one column short of the divider so its scrollbar does
    // not sit flush against the rule.
    const listW = leftW - 1

    scr.vline(body.x + leftW, body.y, body.h, S.border)

    // Filter line sits above the list when active.
    let listY = body.y
    let listH = body.h
    if (this.filtering || this.filter) {
      scr.put(body.x + 1, listY, '/', S.accent)
      scr.put(body.x + 3, listY, this.filter || '…', this.filter ? S.title : S.dim)
      if (this.filtering) scr.put(body.x + 3 + stringWidth(this.filter), listY, ' ', S.selOn)
      listY += 1
      listH -= 1
    }

    this.list.draw(scr, body.x, listY, listW, listH, (item, { selected, width }) => {
      if (item.kind === 'header') {
        return [{ text: ' ' + item.label, style: S.heading }]
      }
      if (item.kind === 'empty') {
        return [{ text: '  ' + item.label, style: S.dim }]
      }
      const s = item.session
      const title = Sessions.displayTitle(s)
      const proj = shortProject(s.cwd) || s.project
      const age = formatAge(s.mtime)

      const ageW = 4
      const projW = Math.min(18, Math.max(8, Math.floor(width * 0.32)))
      const titleW = width - projW - ageW - 5

      let mark = '  '
      let markStyle = S.dim
      if (item.live) { mark = ' ' + statusGlyph(item.live.status); markStyle = statusStyle(item.live.status) }
      else if (item.pinned) { mark = ' ★'; markStyle = S.warn }

      return [
        { text: mark + ' ', style: markStyle },
        { text: fit(title, titleW), style: item.live ? S.title : S.base },
        { text: fit(proj, projW), style: S.muted },
        { text: fit(age, ageW, 'right'), style: S.dim },
      ]
    }, { focused: !this.filtering })

    this.renderPreview(app, rightX, body.y, rightW, body.h)
  }

  renderPreview(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item || item.kind !== 'session') {
      scr.put(x + 2, y + 1, 'nothing selected', S.dim)
      return
    }
    const s = item.session
    const inner = w - 4
    let cy = y

    const title = Sessions.displayTitle(s)
    scr.put(x + 2, cy, truncate(title, inner), S.title); cy++
    scr.hline(x + 2, cy, inner, S.border); cy += 2

    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x + 2, cy, fit(label, 9), S.muted)
      scr.put(x + 11, cy, truncate(String(value), inner - 9), style)
      cy++
    }

    const cwd = s.cwd || null
    field('project', cwd ? tildify(cwd) : `${s.project} (path unknown)`,
      cwd && !exists(cwd) ? S.err : S.base)
    if (cwd && !exists(cwd)) field('', 'directory no longer exists', S.err)
    field('branch', s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null)
    field('started', s.startedAt ? new Date(s.startedAt).toLocaleString() : null)
    field('touched', formatAgo(s.mtime))
    field('size', formatBytes(s.size))
    field('version', s.version)

    if (item.live) {
      const l = item.live
      scr.put(x + 2, cy, fit('status', 9), S.muted)
      scr.put(x + 11, cy, '● ' + l.status, statusStyle(l.status))
      scr.put(x + 11 + 3 + l.status.length, cy, `  pid ${l.pid}`, S.dim)
      cy++
    }
    if (item.pinned) {
      const pin = State.loadState().pins.find((p) => p.sessionId === s.id)
      field('pinned', pin?.label ? `★ ${pin.label}` : '★ yes', S.warn)
    }
    field('id', s.id, S.dim)

    const prompt = s.lastPrompt || s.firstPrompt
    if (prompt && cy < y + h - 3) {
      cy++
      scr.put(x + 2, cy, 'last prompt', S.heading); cy++
      const lines = wrap(prompt, inner)
      for (const line of lines.slice(0, Math.max(0, y + h - cy - 1))) {
        scr.put(x + 2, cy, line, S.muted); cy++
      }
    }
  }

  selectedSession() {
    const item = this.list.selected()
    return item && item.kind === 'session' ? item : null
  }

  async onMouse(m, app) {
    const r = listMouse(this.list, m)
    if (r === 'activate') await this.onKey({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false }, app)
    return !!r
  }

  async onKey(ev, app) {
    // Filter mode swallows most input.
    if (this.filtering) {
      if (ev.name === 'escape') { this.filtering = false; this.filter = ''; this.rebuild(); return true }
      if (ev.name === 'enter') { this.filtering = false; return true }
      if (ev.name === 'backspace') { this.filter = this.filter.slice(0, -1); this.rebuild(); return true }
      if (ev.name === 'up') { this.list.move(-1); return true }
      if (ev.name === 'down') { this.list.move(1); return true }
      if (!ev.ctrl && !ev.alt && ev.ch) { this.filter += ev.ch; this.rebuild(); return true }
      if (ev.name === 'space') { this.filter += ' '; this.rebuild(); return true }
      return true
    }

    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'pageup': this.list.page(-1, app.screen.rows - 5); return true
      case 'pagedown': this.list.page(1, app.screen.rows - 5); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case '/': this.filtering = true; return true
      case 'escape':
        if (this.filter) { this.filter = ''; this.rebuild(); return true }
        return false
      case 'r':
        this.reload(app)
        app.toast('rescanned')
        return true
    }

    const item = this.selectedSession()

    if (ev.name === 'enter' && item) {
      await this.resume(app, item)
      return true
    }
    if (ev.name === 'n') {
      app.switchTo('launch')
      return true
    }
    if (ev.name === 'c' && item) {
      const cfg = { ...emptyConfig(), dir: item.session.cwd || process.cwd() }
      cfg.flags.continue = true
      cfg.flags.skipPermissions = true
      await app.launch(cfg)
      return true
    }
    if (ev.name === 'p' && item) {
      const nowPinned = State.togglePin(
        { project: item.session.project, id: item.session.id },
        Sessions.displayTitle(item.session),
      )
      this.rebuild()
      app.toast(nowPinned ? 'pinned' : 'unpinned')
      return true
    }
    if (ev.name === 'P' && item) {
      const label = await promptText(app, {
        title: 'Rename pin',
        label: 'Shown in the pinned list',
        value: State.loadState().pins.find((p) => p.sessionId === item.session.id)?.label ?? Sessions.displayTitle(item.session),
      })
      if (label) { State.renamePin({ project: item.session.project, id: item.session.id }, label); this.rebuild() }
      return true
    }
    if (ev.name === 'o' && item && item.session.cwd) {
      openFolder(item.session.cwd)
      app.toast('opened ' + tildify(item.session.cwd))
      return true
    }
    if (ev.name === 'x' && item) {
      const s = item.session
      if (item.live) { app.error('that session is running — quit it first'); return true }
      const ok = await confirm(app, {
        title: 'Delete transcript',
        message: `Delete "${Sessions.displayTitle(s)}"?`,
        detail: `${formatBytes(s.size)} · ${path.basename(s.file)}`,
        danger: true,
        yes: 'Delete',
      })
      if (ok) {
        Sessions.deleteSession(s)
        this.reload(app)
        app.toast('deleted', S.warn)
      }
      return true
    }
    return false
  }

  async resume(app, item) {
    const s = item.session
    const cfg = { ...emptyConfig(), dir: s.cwd || process.cwd(), resume: s.id }
    cfg.flags.skipPermissions = true
    if (s.cwd && !exists(s.cwd)) {
      const ok = await confirm(app, {
        title: 'Directory missing',
        message: `${tildify(s.cwd)} no longer exists.`,
        detail: 'Resume from the current directory instead?',
        yes: 'Resume here',
      })
      if (!ok) return
      cfg.dir = process.cwd()
    }
    await app.launch(cfg)
  }
}
