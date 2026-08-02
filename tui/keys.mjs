// Raw-mode keyboard input.
//
// Node's readline keypress events swallow some sequences and behave slightly
// differently across platforms, so the escape sequences are decoded here
// directly. Emits { name, ch, ctrl, alt, shift, raw }.

const KEY_NAMES = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\b': 'backspace',
  '\x7f': 'backspace',
  '\x1b': 'escape',
  ' ': 'space',
}

// CSI final byte / tilde-number → key name
const CSI_KEYS = {
  A: 'up', B: 'down', C: 'right', D: 'left',
  H: 'home', F: 'end',
  E: 'clear', Z: 'tab', // Z is shift-tab, flagged below
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
}

const TILDE_KEYS = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
  5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5',
  17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10',
  23: 'f11', 24: 'f12',
}

function modsFrom(n) {
  // xterm encodes modifiers as 1 + bitmask
  const m = (n || 1) - 1
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) }
}

// Decode one key from the front of `buf`; returns [event, bytesConsumed].
function decode(buf) {
  const s = buf

  if (s[0] === '\x1b') {
    // Lone Escape
    if (s.length === 1) return [{ name: 'escape', ch: '', ctrl: false, alt: false, shift: false, raw: s }, 1]

    // CSI
    if (s[1] === '[') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s)
      if (!m) return [null, 0] // incomplete
      const [full, params, final] = m
      const parts = params.split(';').filter((p) => p !== '').map(Number)

      if (final === '~') {
        const name = TILDE_KEYS[parts[0]]
        const mods = modsFrom(parts[1])
        if (!name) return [null, full.length]
        return [{ name, ch: '', ...mods, raw: full }, full.length]
      }

      let name = CSI_KEYS[final]
      if (!name) return [null, full.length]
      let mods = modsFrom(parts[1])
      if (final === 'Z') mods = { shift: true, alt: false, ctrl: false }
      return [{ name, ch: '', ...mods, raw: full }, full.length]
    }

    // SS3 — arrows in application cursor mode
    if (s[1] === 'O') {
      if (s.length < 3) return [null, 0]
      const name = CSI_KEYS[s[2]]
      if (!name) return [null, 3]
      return [{ name, ch: '', ctrl: false, alt: false, shift: false, raw: s.slice(0, 3) }, 3]
    }

    // Alt + key
    const [ev, n] = decode(s.slice(1))
    if (!ev) return [null, 0]
    return [{ ...ev, alt: true, raw: s.slice(0, n + 1) }, n + 1]
  }

  const ch = String.fromCodePoint(s.codePointAt(0))
  const code = s.codePointAt(0)

  if (KEY_NAMES[ch]) {
    return [{ name: KEY_NAMES[ch], ch: ch === ' ' ? ' ' : '', ctrl: false, alt: false, shift: false, raw: ch }, ch.length]
  }

  // Ctrl + letter
  if (code > 0 && code < 27) {
    const letter = String.fromCharCode(code + 96)
    return [{ name: letter, ch: '', ctrl: true, alt: false, shift: false, raw: ch }, 1]
  }
  if (code === 0) {
    return [{ name: 'space', ch: '', ctrl: true, alt: false, shift: false, raw: ch }, 1]
  }

  return [{ name: ch, ch, ctrl: false, alt: false, shift: false, raw: ch }, ch.length]
}

export class Keyboard {
  constructor(input = process.stdin) {
    this.input = input
    this.buf = ''
    this.queue = []
    // A stack, not a single slot. Modals nest — each opens its own read loop
    // while an outer one is still pending — and a lone slot would silently
    // overwrite the outer waiter, orphaning its promise and killing input for
    // the rest of the session. Last waiter in wins, which is the innermost
    // modal, and everything below it stays intact.
    this.waiters = []
    this.started = false
    this._onData = (chunk) => this.#feed(chunk)
  }

  start() {
    if (this.started) return
    this.started = true
    if (this.input.isTTY) this.input.setRawMode(true)
    this.input.setEncoding('utf8')
    this.input.resume()
    this.input.on('data', this._onData)
  }

  stop() {
    if (!this.started) return
    this.started = false
    if (this._escTimer) { clearTimeout(this._escTimer); this._escTimer = null }
    this.input.removeListener('data', this._onData)
    if (this.input.isTTY) this.input.setRawMode(false)
    this.input.pause()
    this.flush()
  }

  #feed(chunk) {
    this.buf += chunk
    // A lone ESC at the end may be the start of a sequence still in flight;
    // decode() returns [null, 0] for that and we wait for the rest.
    while (this.buf.length) {
      const [ev, n] = decode(this.buf)
      if (n === 0) {
        if (this.buf === '\x1b') {
          // Nothing followed — treat as a real Escape after a short grace.
          if (!this._escTimer) {
            this._escTimer = setTimeout(() => {
              this._escTimer = null
              if (this.buf === '\x1b') {
                this.buf = ''
                this.#emit({ name: 'escape', ch: '', ctrl: false, alt: false, shift: false, raw: '\x1b' })
              }
            }, 40)
          }
        }
        return
      }
      if (this._escTimer) { clearTimeout(this._escTimer); this._escTimer = null }
      this.buf = this.buf.slice(n)
      if (ev) this.#emit(ev)
    }
  }

  #emit(ev) {
    const w = this.waiters.pop()
    if (w) w(ev)
    else this.queue.push(ev)
  }

  // Await the next keypress.
  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift())
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  // Release every pending reader — used when tearing down so no promise is
  // left dangling and the process can exit.
  flush() {
    const pending = this.waiters.splice(0)
    for (const w of pending) w({ name: 'escape', ch: '', ctrl: false, alt: false, shift: false, raw: '' })
  }
}

// True when the event is a plain printable character (no modifiers).
export function isPrintable(ev) {
  return !ev.ctrl && !ev.alt && ev.ch && ev.ch.length > 0 && ev.ch >= ' '
}
