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
import { Vim, VIM_HELP } from './tui/vim.mjs'
import { runClaude, displayCommand } from './launch.mjs'
import { saveState } from './data/state.mjs'
import { tildify } from './data/paths.mjs'

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
    this.screen.onResize = () => this.render()
    for (const s of screens) s.app = this
  }

  get current() {
    return this.screens[this.index]
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
    drawHeader(scr, {
      tabs: this.screens.map((s) => s.title),
      active: this.index,
      right: this.current.headerRight?.(this) ?? '',
    })
    const body = { x: 0, y: 2, w: scr.cols, h: scr.rows - 3 }
    this.current.render(this, body)

    if (this.message && Date.now() > this.messageUntil) this.message = null
    drawFooter(scr, this.current.keys ?? [], {
      message: this.message,
      messageStyle: this.messageStyle,
    })
  }

  render() {
    this.renderBase()
    this.screen.flush()
  }

  step(delta) {
    this.switchTo((this.index + delta + this.screens.length) % this.screens.length)
  }

  async handleKey(raw) {
    if (raw.ctrl && raw.name === 'c') { this.quit(); return }

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

    // Left/right that no screen claimed moves between screens, the way h/l
    // moves between panels in lazygit. Screens that use them for their own
    // navigation — Launch's enums, the JSON tree's fold — consume them first.
    if (ev.name === 'left') { this.step(-1); return }
    if (ev.name === 'right') { this.step(1); return }
  }

  async showHelp() {
    const lines = [
      { text: 'Navigation  (vim keys work everywhere)', style: S.heading },
      ...VIM_HELP.map((l) => '  ' + l),
      '',
      { text: 'Global', style: S.heading },
      '  1-4 / tab      switch screen',
      '  ?              this help',
      '  q / ctrl-c     quit',
      '  esc            step back, or close an overlay',
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
    for (const s of this.screens) s.onReturn?.(this)
    return result
  }

  async run() {
    this.screen.enter()
    this.kb.start()
    this.current.onEnter?.(this)
    this.render()

    try {
      while (this.running) {
        const ev = await this.kb.next()
        await this.handleKey(ev)
        if (this.running) this.render()
      }
    } finally {
      if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null }
      this.kb.stop()
      this.screen.leave()
      saveState()
    }
  }
}
