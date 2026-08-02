// Dispatch — what is running right now.
//
// Sessions lists everything you have ever run; this lists only what is alive,
// and says what each one is doing. Sorted so anything waiting on you is at the
// top, then whatever is working, then idle.
//
// The list comes from sessions/*.json, which is cheap and refreshed once a
// second by the app. The detail pane reads the tail of the selected session's
// transcript for its model, context size and current activity — that read is
// cached on the file's size and mtime, so holding the cursor still costs
// nothing.

import fs from 'node:fs'
import { S, statusStyle, statusGlyph, statusLabel, gaugeStyle } from '../tui/theme.mjs'
import { List, confirm, drawBar, fmtTokens, listMouse } from '../tui/widgets.mjs'
import { truncate, fit, wrap, stringWidth } from '../tui/width.mjs'
import * as Sessions from '../data/sessions.mjs'
import { tildify, shortProject, formatAge, formatAgo, formatBytes, exists } from '../data/paths.mjs'
import { emptyConfig, openFolder } from '../launch.mjs'

const ORDER = { waiting: 0, busy: 1, idle: 2 }

export class DispatchScreen {
  id = 'dispatch'
  title = 'Dispatch'
  keys = [
    ['enter', 'attach'], ['o', 'folder'], ['n', 'new'],
    ['w', 'next waiting'], ['r', 'refresh'], ['?', 'help'],
  ]
  help = [
    'enter        resume the highlighted session',
    'o            open its working directory',
    'n            start a new session (opens Launch)',
    'w            jump to the next session waiting on you',
    'r            refresh now',
    '',
    'Updates on its own once a second, and immediately when Claude writes a',
    'status change. A session is "waiting" when it needs input from you.',
    '',
    'Context is the size of the last request Claude sent — prompt plus cache.',
    'Output is the token count of its most recent reply.',
  ]

  // Tells the app to redraw at animation rate while something is working.
  animates = true

  constructor() {
    this.list = new List([])
    this.lastSig = null
  }

  async onMouse(m, app) {
    const r = listMouse(this.list, m)
    if (r === 'activate') await this.onKey({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false }, app)
    return !!r
  }

  onEnter(app) {
    this.rebuild(app)
  }

  onReturn(app) {
    this.rebuild(app)
  }

  // Called once a second by the app. Rebuild only when something moved.
  onTick(app) {
    const sig = Sessions.liveSignature(app.live ?? [])
    if (sig === this.lastSig) return false
    this.rebuild(app)
    return true
  }

  rebuild(app) {
    const live = [...(app.live ?? [])]
    this.lastSig = Sessions.liveSignature(live)
    live.sort((a, b) => {
      const d = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
      return d !== 0 ? d : (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    const items = live.map((l) => ({ id: l.id, kind: 'live', live: l }))
    if (!items.length) {
      items.push({ id: 'empty', kind: 'empty', selectable: false })
    }
    this.list.setItems(items)
  }

  headerRight(app) {
    const live = app.live ?? []
    if (!live.length) return 'nothing running'
    const busy = live.filter((l) => l.status === 'busy').length
    const bits = [`${live.length} running`]
    if (busy) bits.push(`${busy} working`)
    return bits.join(' · ')
  }

  render(app, body) {
    const scr = app.screen
    const live = app.live ?? []

    if (!live.length) {
      const lines = [
        'Nothing is running.',
        '',
        'Every Claude Code process registers itself, so sessions started',
        'outside cl appear here too, as soon as they start.',
        '',
        'n  start a new session        2  browse past sessions',
      ]
      lines.forEach((l, i) => scr.put(body.x + 2, body.y + 1 + i, truncate(l, body.w - 4), i === 0 ? S.muted : S.dim))
      return
    }

    const leftW = Math.max(34, Math.min(56, Math.floor(body.w * 0.44)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    const now = Date.now()
    this.list.draw(scr, body.x, body.y, leftW - 1, body.h, (item, { selected, width }) => {
      if (item.kind === 'empty') return [{ text: '  nothing running', style: S.dim }]
      const l = item.live
      const st = statusStyle(l.status)
      const name = l.name || l.id.slice(0, 8)
      const proj = shortProject(l.cwd) || ''
      const age = formatAge(l.statusUpdatedAt || l.updatedAt)

      const ageW = 5
      const projW = Math.min(16, Math.max(6, Math.floor(width * 0.3)))
      const nameW = width - projW - ageW - 5

      return [
        { text: ' ' + statusGlyph(l.status, now) + ' ', style: st },
        { text: fit(name, nameW), style: l.status === 'waiting' ? S.title : S.base },
        { text: fit(proj, projW), style: S.muted },
        { text: fit(age, ageW, 'right'), style: S.dim },
      ]
    })

    this.renderDetail(app, body.x + leftW + 2, body.y, body.w - leftW - 3, body.h)
  }

  renderDetail(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item || item.kind !== 'live') return
    const l = item.live
    let cy = y

    scr.put(x, cy, truncate(l.name || l.id.slice(0, 8), w), S.title); cy++
    scr.hline(x, cy, w, S.border); cy += 2

    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x, cy, fit(label, 9), S.muted)
      scr.put(x + 9, cy, truncate(String(value), w - 9), style)
      cy++
    }

    // Status, and how long it has been in this state — a session "waiting" for
    // twenty minutes is a different situation from one waiting for two.
    const since = formatAge(l.statusUpdatedAt || l.updatedAt)
    scr.put(x, cy, fit('status', 9), S.muted)
    let sx = x + 9
    sx = scr.put(sx, cy, statusGlyph(l.status) + ' ' + statusLabel(l.status), statusStyle(l.status))
    scr.put(sx, cy, `  for ${since}`, S.dim)
    cy++

    field('project', l.cwd ? tildify(l.cwd) : null, l.cwd && !exists(l.cwd) ? S.err : S.base)
    field('started', formatAgo(l.startedAt))
    field('pid', `${l.pid}${l.kind && l.kind !== 'interactive' ? `  (${l.kind})` : ''}`, S.dim)

    const file = Sessions.transcriptFor(l)
    const act = file ? Sessions.readActivity(file) : null

    if (act) {
      if (act.model) field('model', act.model.replace(/^claude-/, ''))

      // Context as a gauge. The window is inferred from the count rather than
      // the model name, because a 1M-context session still reports itself as
      // plain "claude-opus-5" — the only honest signal is that it has already
      // exceeded 200k.
      if (act.contextTokens) {
        const window = contextWindow(act.contextTokens)
        const frac = act.contextTokens / window
        scr.put(x, cy, fit('context', 9), S.muted)
        const label = `${fmtTokens(act.contextTokens)} / ${fmtTokens(window)}`
        scr.put(x + 9, cy, label, gaugeStyle(frac))
        const pct = `${Math.round(frac * 100)}%`
        if (x + w - stringWidth(pct) > x + 9 + stringWidth(label) + 2) {
          scr.put(x + w - stringWidth(pct), cy, pct, gaugeStyle(frac))
        }
        cy++
        drawBar(scr, x + 9, cy, Math.max(4, w - 9), frac, { style: gaugeStyle(frac) })
        cy += 2
      }

      const stats = []
      if (act.outputTokens) stats.push(`${fmtTokens(act.outputTokens)} out`)
      if (act.tools) stats.push(`${act.tools} tool${act.tools === 1 ? '' : 's'}`)
      try { stats.push(formatBytes(fs.statSync(file).size)) } catch { /* stat raced a write */ }
      if (stats.length) field('turn', stats.join('  ·  '))
    }

    // Current activity — the newest thing in the transcript.
    if (act?.activity && cy < y + h - 4) {
      cy++
      const label = act.activityKind === 'tool' ? 'running'
        : act.activityKind === 'user' ? 'you said'
        : 'saying'
      scr.put(x, cy, label, S.heading); cy++
      const style = act.activityKind === 'tool' ? S.info : S.base
      for (const line of wrap(act.activity, w).slice(0, 4)) {
        if (cy >= y + h - 2) break
        scr.put(x, cy, line, style); cy++
      }
    }

    if (act?.lastPrompt && act.activityKind !== 'user' && cy < y + h - 3) {
      cy++
      scr.put(x, cy, 'last prompt', S.heading); cy++
      for (const line of wrap(act.lastPrompt, w).slice(0, 3)) {
        if (cy >= y + h - 1) break
        scr.put(x, cy, line, S.muted); cy++
      }
    }

    if (!file && cy < y + h - 1) {
      cy++
      scr.put(x, cy, 'no transcript found for this session', S.dim)
    }
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'r': app.refreshLive(); this.rebuild(app); app.toast('refreshed'); return true
      case 'n': app.switchTo('launch'); return true
      case 'w': {
        const i = this.list.items.findIndex((it) => it.live?.status === 'waiting')
        if (i >= 0) { this.list.moveTo(i); app.toast('jumped to the session waiting on you') }
        else app.toast('nothing is waiting on you', S.ok)
        return true
      }
      case 'escape': app.switchTo('sessions'); return true
    }

    const item = this.list.selected()
    if (!item || item.kind !== 'live') return false
    const l = item.live

    if (ev.name === 'enter') {
      const cfg = { ...emptyConfig(), dir: l.cwd && exists(l.cwd) ? l.cwd : process.cwd(), resume: l.id }
      cfg.flags.skipPermissions = true
      const ok = await confirm(app, {
        title: 'Attach to a running session',
        message: `"${l.name || l.id.slice(0, 8)}" is running as pid ${l.pid}.`,
        detail: 'Resuming opens a second view of it. Continue?',
        yes: 'Resume',
      })
      if (ok) await app.launch(cfg)
      return true
    }
    if (ev.name === 'o' && l.cwd) {
      openFolder(l.cwd)
      app.toast('opened ' + tildify(l.cwd))
      return true
    }
    return false
  }
}

// Standard context windows, smallest first. A session is assumed to be using
// the smallest one it still fits inside.
const WINDOWS = [200_000, 1_000_000]

function contextWindow(tokens) {
  return WINDOWS.find((w) => tokens <= w) ?? WINDOWS[WINDOWS.length - 1]
}
