// Vim-style navigation, translated once for the whole application.
//
// Screens only ever handle the canonical names — up, down, left, right, home,
// end, pageup, pagedown — so bindings live here instead of being repeated in
// every key handler. A new screen gets vim navigation without knowing about it.
//
// Two rules keep this from fighting the rest of the UI:
//
//   1. Translation is skipped entirely while a screen is capturing text (the
//      Sessions filter), and modals read the keyboard directly, so typing "j"
//      into a prompt types a j.
//   2. Only navigation is remapped. Actions stay where each screen defines
//      them, except `d`, which is aliased to `x` because every screen already
//      uses `x` for delete and lazygit users reach for `d`.

const NAV = {
  j: 'down',
  k: 'up',
  h: 'left',
  l: 'right',
  G: 'end',
}

// Ctrl chords. Half-page scrolling maps onto whole pages: screens size their
// own page from the visible height, and a half-page variant is not worth a
// second code path.
const CTRL = {
  d: 'pagedown',
  u: 'pageup',
  f: 'pagedown',
  b: 'pageup',
  n: 'down',
  p: 'up',
}

// Actions that are the same verb under a different finger.
const ALIAS = {
  d: 'x',
}

// Multi-key sequences. Only `gg` for now — `dd` would be ambiguous against the
// `d` delete alias, and lazygit uses a single `d` anyway.
const CHORD_PREFIXES = new Set(['g'])

export class Vim {
  constructor({ chordTimeoutMs = 700 } = {}) {
    this.pending = null
    this.pendingAt = 0
    this.chordTimeoutMs = chordTimeoutMs
  }

  // Returns a translated event, or null when the key was swallowed as the
  // first half of a chord.
  translate(ev) {
    if (!ev || ev.alt) return ev

    // Resolve a pending chord first.
    if (this.pending) {
      const prefix = this.pending
      const age = Date.now() - this.pendingAt
      this.pending = null
      // Strictly less than, so a timeout of 0 disables chords outright.
      if (age < this.chordTimeoutMs && !ev.ctrl) {
        if (prefix === 'g' && ev.name === 'g') return { ...ev, name: 'home' }
        if (prefix === 'g' && ev.name === 'e') return { ...ev, name: 'end' }
      }
      // Not a chord we know — fall through and treat this key normally.
    }

    if (ev.ctrl) {
      const name = CTRL[ev.name]
      return name ? { ...ev, name, ctrl: false } : ev
    }

    if (CHORD_PREFIXES.has(ev.name)) {
      this.pending = ev.name
      this.pendingAt = Date.now()
      return null
    }

    if (NAV[ev.name]) return { ...ev, name: NAV[ev.name] }
    if (ALIAS[ev.name]) return { ...ev, name: ALIAS[ev.name] }
    return ev
  }

  reset() {
    this.pending = null
  }
}

// Shown in the help overlay.
export const VIM_HELP = [
  'j / k          down / up',
  'h / l          left / right — or previous / next screen',
  'gg / G         top / bottom',
  'ctrl-d / -u    page down / up',
  'ctrl-f / -b    page down / up',
  'd              delete (same as x)',
  '[ / ]          previous / next screen',
  '/              search      esc  back      q  quit',
]
