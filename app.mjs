// The application shell: owns the screen stack, the key loop, and the
// transition in and out of a Claude session.
//
// Screens implement { id, title, keys, render(app), onKey(ev, app) }. onKey
// returns true when it consumed the event; anything it does not consume falls
// through to the global bindings here.

import { Screen } from './tui/screen.mjs'
import { Keyboard } from './tui/keys.mjs'
import { S } from './tui/theme.mjs'
import { drawHeader, drawFooter, showText } from './tui/widgets.mjs'
import { SPINNER_MS } from './tui/theme.mjs'
import { sparkline, fmtCount } from './tui/charts.mjs'
import { stringWidth } from './tui/width.mjs'
import * as Usage from './data/usage.mjs'
import { Vim, VIM_HELP } from './tui/vim.mjs'
import fs from 'node:fs'
import { runClaude, displayCommand } from './launch.mjs'
import { saveState, loadState } from './data/state.mjs'
import { listLive, liveSignature } from './data/sessions.mjs'
import { P, tildify } from './data/paths.mjs'

export class App {
  constructor(screens) {
    this.screen = new Screen()
    this.kb = new Keyboard()
    this.screens = screens
    this.index = 0
    this.running = true
    this.message = null
    this.messageStyle = S.muted
    this.messageUntil = 0
    this.overlays = 0
    this._toastTimer = null
    this.exitAfterLaunch = false
    this.vim = new Vim()
    this.live = []
    this._liveSig = null
    this.statsBar = loadState().ui?.statsBar === true
    this.screen.onResize = () => this.render()
    for (const s of screens) s.app = this
  }

  get current() {
    return this.screens[this.index]
  }

  // ── Live refresh ───────────────────────────────────────────────────
  // Frames are otherwise only drawn in response to a keypress, so a session
  // that finished, started waiting on you, or changed what it is doing would
  // sit on screen as a stale snapshot until you pressed something.
  //
  // A one-second poll picks up status changes; a watch on sessions/ makes the
  // common case near-instant. Neither ever paints over an open modal.

  refreshLive() {
    let list = []
    try { list = listLive() } catch { /* directory may be mid-write */ }
    const sig = liveSignature(list)
    const changed = sig !== this._liveSig
    this._liveSig = sig
    this.live = list
    return changed
  }

  get needsYou() {
    return (this.live ?? []).filter((l) => l.status === 'waiting')
  }

  // True when the visible screen has something moving on it. Only then is it
  // worth redrawing at animation rate.
  get animating() {
    return this.current.animates === true && (this.live ?? []).some((l) => l.status === 'busy')
  }

  startLiveRefresh() {
    // Two cadences on one timer. Reading sessions/*.json every frame would be
    // wasteful, but drawing only once a second makes a spinner advance ten
    // frames between paints, which reads as flicker rather than rotation. So:
    // poll on a 1s boundary, draw at SPINNER_MS while something is animating.
    const POLL_MS = 1000
    let sincePoll = 0

    const step = () => {
      if (!this.running || this.overlays > 0) return
      sincePoll += this._interval

      let liveChanged = false
      if (sincePoll >= POLL_MS) {
        sincePoll = 0
        liveChanged = this.refreshLive()
      }

      const screenWants = this.current.onTick?.(this) === true
      const animating = this.animating
      if (liveChanged || screenWants || animating) this.render()

      const want = animating ? SPINNER_MS : POLL_MS
      if (want !== this._interval) this.#retime(want)
    }

    this._tick = step
    this.#retime(this.animating ? SPINNER_MS : POLL_MS)

    try {
      this._watcher = fs.watch(P.sessions, { persistent: false }, () => {
        clearTimeout(this._watchDebounce)
        this._watchDebounce = setTimeout(() => {
          if (!this.running || this.overlays > 0) return
          if (this.refreshLive()) this.render()
        }, 120)
        this._watchDebounce?.unref?.()
      })
      this._watcher.on?.('error', () => {})
    } catch { /* watching is an optimisation; the poll still covers it */ }
  }

  #retime(ms) {
    if (this._ticker) clearInterval(this._ticker)
    this._interval = ms
    this._ticker = setInterval(this._tick, ms)
    this._ticker.unref?.()
  }

  stopLiveRefresh() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null }
    if (this._watchDebounce) { clearTimeout(this._watchDebounce); this._watchDebounce = null }
    if (this._watcher) { try { this._watcher.close() } catch { /* already gone */ } ; this._watcher = null }
  }

  // Frames are only drawn in response to a keypress, so an expired message
  // would otherwise sit in the footer until you happened to press something.
  // The timer repaints when it lapses — unless a modal is open, in which case
  // the modal owns the screen and will clear it on its next frame.
  toast(text, style = S.ok, ms = 3000) {
    this.message = text
    this.messageStyle = style
    this.messageUntil = Date.now() + ms

    if (this._toastTimer) clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null
      if (!this.running || this.overlays > 0) return
      if (Date.now() < this.messageUntil) return
      this.message = null
      this.render()
    }, ms + 20)
    this._toastTimer.unref?.()
  }

  error(text) {
    this.toast(text, S.err, 6000)
  }

  switchTo(idOrIndex) {
    const i = typeof idOrIndex === 'number'
      ? idOrIndex
      : this.screens.findIndex((s) => s.id === idOrIndex)
    if (i < 0 || i >= this.screens.length) return
    this.index = i
    this.current.onEnter?.(this)
  }

  // Draw the current screen without flushing — modals call this to repaint
  // the background before drawing themselves.
  renderBase() {
    const scr = this.screen
    scr.begin()
    // A session waiting on input is worth surfacing from every screen, not
    // only the one listing sessions.
    const waiting = this.needsYou
    this._tabRects = drawHeader(scr, {
      tabs: this.screens.map((s) => s.title),
      active: this.index,
      right: this.current.headerRight?.(this) ?? '',
      alert: waiting.length
        ? `! ${waiting.length} need${waiting.length === 1 ? 's' : ''} you`
        : '',
    })
    const statsH = this.statsBar ? 2 : 0
    const body = { x: 0, y: 2, w: scr.cols, h: scr.rows - 3 - statsH }
    this.current.render(this, body)
    if (this.statsBar) this.drawStatsBar(scr, scr.rows - 3)

    if (this.message && Date.now() > this.messageUntil) this.message = null
    drawFooter(scr, this.current.keys ?? [], {
      message: this.message,
      messageStyle: this.messageStyle,
    })

    scr.setTitle(this.windowTitle())
  }

  // What the terminal (and the tmux window, when automatic-rename is off)
  // shows. Carries the one thing worth seeing without switching to the pane:
  // whether something is waiting on you.
  windowTitle() {
    if (process.env.CL_TITLE) return process.env.CL_TITLE
    const live = this.live ?? []
    const waiting = live.filter((l) => l.status === 'waiting').length
    const busy = live.filter((l) => l.status === 'busy').length
    if (waiting) return `cl ! ${waiting}`
    if (busy) return `cl · ${busy} running`
    return 'cl'
  }

  render() {
    this.renderBase()
    this.screen.flush()
  }

  step(delta) {
    this.switchTo((this.index + delta + this.screens.length) % this.screens.length)
  }

  // Clicks on the tab strip switch screens; everything below the rule belongs
  // to the current screen.
  async handleMouse(m) {
    if (m.release) return
    if (m.y <= 1) {
      if (m.press && m.button === 0) {
        const hit = (this._tabRects ?? []).find((r) => m.x >= r.x && m.x < r.x + r.w)
        if (hit) this.switchTo(hit.index)
      }
      return
    }
    await this.current.onMouse?.(m, this)
  }

  async handleKey(raw) {
    if (raw.ctrl && raw.name === 'c') { this.quit(); return }
    if (raw.name === 'mouse') { await this.handleMouse(raw.mouse); return }

    // A screen capturing text sees the key untranslated, so typing "j" into
    // the filter types a j rather than moving the cursor.
    let ev = raw
    if (this.current.textEntry) {
      this.vim.reset()
    } else {
      const translated = this.vim.translate(raw)
      if (translated === null) return // first half of a chord; wait for the rest
      ev = translated
    }

    if (await this.current.onKey?.(ev, this)) return

    if (ev.name === 'q' && !ev.ctrl) { this.quit(); return }
    if (ev.name === 'tab') { this.step(ev.shift ? -1 : 1); return }
    if (ev.name === '[') { this.step(-1); return }
    if (ev.name === ']') { this.step(1); return }
    if (/^[1-9]$/.test(ev.name) && !ev.ctrl && !ev.alt) {
      const i = Number(ev.name) - 1
      if (i < this.screens.length) this.switchTo(i)
      return
    }
    if (ev.name === '?') { await this.showHelp(); return }
    if (ev.name === '`') {
      this.statsBar = !this.statsBar
      const st = loadState()
      st.ui = { ...(st.ui ?? {}), statsBar: this.statsBar }
      saveState()
      this.toast(this.statsBar ? 'summary bar on' : 'summary bar off')
      return
    }

    // Left/right that no screen claimed moves between screens, the way h/l
    // moves between panels in lazygit. Screens that use them for their own
    // navigation — Launch's enums, the JSON tree's fold — consume them first.
    if (ev.name === 'left') { this.step(-1); return }
    if (ev.name === 'right') { this.step(1); return }
  }

  // A one-line summary that can sit under any screen. Kept to real figures:
  // a rolling window over recorded usage, never a quota — Claude does not
  // write its rate limits to disk, so cl cannot know what is left.
  drawStatsBar(scr, y) {
    scr.hline(0, y, scr.cols, S.border)
    const yy = y + 1
    scr.fill(0, yy, scr.cols, 1, ' ', S.base)

    let agg
    try { agg = Usage.collect({ maxAgeMs: 10_000 }) } catch { return }
    const win = Usage.window(agg)
    const day = Usage.today(agg)

    let x = 1
    const cell = (label, value, style = S.base) => {
      x = scr.put(x, yy, label + ' ', S.muted)
      x = scr.put(x, yy, value, style)
      x = scr.put(x, yy, '   ', S.base)
    }
    cell(`${Usage.WINDOW_HOURS}h`, `${fmtCount(win.out)} out · ${win.msgs} turns`, S.title)
    cell('today', `${fmtCount(day.out)} · ${day.msgs}`)
    cell('all', `${fmtCount(agg.out)} · ${fmtCount(agg.messages)}`)

    // Sparkline last, using whatever width is left.
    const room = scr.cols - x - 2
    if (room > 12) {
      const pts = Usage.series(agg, { hours: 6, points: Math.min(room, 60) })
      scr.put(scr.cols - 1 - pts.length, yy, sparkline(pts), S.accent)
      const lbl = '6h'
      if (scr.cols - 1 - pts.length - stringWidth(lbl) - 1 > x) {
        scr.put(scr.cols - 2 - pts.length - stringWidth(lbl), yy, lbl, S.dim)
      }
    }
  }

  async showHelp() {
    const lines = [
      { text: 'Navigation  (vim keys work everywhere)', style: S.heading },
      ...VIM_HELP.map((l) => '  ' + l),
      '',
      { text: 'Global', style: S.heading },
      '  1-5 / tab      switch screen',
      '  ?              this help',
      '  q / ctrl-c     quit',
      '  esc            step back, or close an overlay',
      '',
      { text: 'Mouse', style: S.heading },
      '  wheel          scroll the list',
      '  click          select a row, or a tab in the header',
      '  click again    open the selected row',
      '',
      { text: this.current.title, style: S.heading },
      ...(this.current.help ?? []).map((l) => '  ' + l),
    ]
    await showText(this, { title: 'Keys', lines })
  }

  quit() {
    this.running = false
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null }
  }

  // Tear the TUI down, run claude, then come back — or exit, when cl was
  // invoked as a one-shot.
  async launch(cfg) {
    this.stopLiveRefresh()
    this.screen.leave()
    this.kb.stop()
    process.stdout.write('\x1b[0m')
    process.stdout.write(`  ${displayCommand(cfg)}\n  in ${tildify(cfg.dir)}\n\n`)

    const result = await runClaude(cfg)
    saveState()

    if (result?.error) {
      // Come back and report rather than dying silently.
      this.screen.enter()
      this.kb.start()
      this.screen.invalidate()
      this.error(`could not run claude: ${result.error.message}`)
      return result
    }

    if (this.exitAfterLaunch) {
      this.running = false
      return result
    }

    this.screen.enter()
    this.kb.start()
    this.screen.invalidate()
    this.refreshLive()
    this.startLiveRefresh()
    for (const s of this.screens) s.onReturn?.(this)
    return result
  }

  async run() {
    this.screen.enter()
    this.kb.start()
    this.refreshLive()
    this.current.onEnter?.(this)
    this.startLiveRefresh()
    this.render()

    try {
      while (this.running) {
        const ev = await this.kb.next()
        // One screen action throwing must not end the session. Before this,
        // any exception unwound out of the loop, through the finally below,
        // and cl simply exited — which reads as "that feature quits the
        // program" rather than as the bug it is. Now it surfaces where it can
        // be reported.
        try {
          await this.handleKey(ev)
        } catch (err) {
          this.error(`${this.current?.id ?? 'cl'}: ${err?.message ?? err}`)
          if (process.env.CL_DEBUG) process.stderr.write(`\n${err?.stack ?? err}\n`)
        }
        if (this.running) this.render()
      }
    } finally {
      if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null }
      this.stopLiveRefresh()
      this.kb.stop()
      this.screen.leave()
      saveState()
    }
  }
}
