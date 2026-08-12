// Colour tokens.
//
// Styles are stored as raw SGR parameter strings ('38;5;39;1') because the
// renderer diffs them as plain strings — cheaper than comparing objects on
// every cell. Depth is detected once at import.

function detectDepth() {
  if (process.env.NO_COLOR !== undefined) return 0
  const forced = process.env.FORCE_COLOR
  if (forced !== undefined) {
    if (forced === '0' || forced === 'false') return 0
    if (forced === '1') return 4
    if (forced === '2') return 8
    return 24
  }
  if (!process.stdout.isTTY) return 0
  const ct = process.env.COLORTERM || ''
  if (/truecolor|24bit/i.test(ct)) return 24
  // Windows Terminal, iTerm2 and VS Code all do truecolor.
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM === 'iTerm.app') return 24
  if (process.env.TERM_PROGRAM === 'vscode') return 24
  const term = process.env.TERM || ''
  if (/256(color)?/i.test(term)) return 8
  if (term === 'dumb' || term === '') return process.platform === 'win32' ? 24 : 0
  return 4
}

export const depth = detectDepth()
export const hasColor = depth > 0

// [r, g, b, xterm256, ansi16]
const P = {
  bg: [26, 27, 38, 234, 30],
  panel: [30, 32, 48, 235, 30],
  fg: [192, 202, 245, 252, 37],
  muted: [86, 95, 137, 243, 90],
  dim: [65, 72, 104, 240, 90],
  border: [52, 59, 88, 238, 90],
  borderOn: [122, 162, 247, 75, 94],
  accent: [122, 162, 247, 75, 94],
  ok: [158, 206, 106, 149, 92],
  warn: [224, 175, 104, 179, 93],
  err: [247, 118, 142, 204, 91],
  info: [125, 207, 255, 117, 96],
  magenta: [187, 154, 247, 141, 95],
}

function fg(name) {
  if (!hasColor) return ''
  const c = P[name]
  if (depth >= 24) return `38;2;${c[0]};${c[1]};${c[2]}`
  if (depth >= 8) return `38;5;${c[3]}`
  return String(c[4])
}

function bg(name) {
  if (!hasColor) return ''
  const c = P[name]
  if (depth >= 24) return `48;2;${c[0]};${c[1]};${c[2]}`
  if (depth >= 8) return `48;5;${c[3]}`
  return String(c[4] + 10)
}

function join(...parts) {
  return parts.filter(Boolean).join(';')
}

export const S = {
  base: fg('fg'),
  muted: fg('muted'),
  dim: fg('dim'),
  border: fg('border'),
  borderOn: fg('borderOn'),
  accent: fg('accent'),
  ok: fg('ok'),
  warn: fg('warn'),
  err: fg('err'),
  info: fg('info'),
  magenta: fg('magenta'),

  title: join(fg('fg'), hasColor ? '1' : ''),
  heading: join(fg('muted'), hasColor ? '1' : ''),
  key: fg('accent'),

  // Selected row: reverse video degrades correctly everywhere, and a real
  // background needs the row painted to full width — which the renderer
  // already does.
  sel: hasColor ? join(bg('panel'), fg('fg'), '1') : '7',
  selOn: hasColor ? join(bg('borderOn'), '38;2;26;27;38', '1') : '7',
}

// Session status. Claude reports busy / waiting / idle in sessions/*.json;
// `waiting` is the one that means it needs you, so it gets the attention
// colour and everything else stays quiet.
export function statusStyle(status) {
  switch (status) {
    // Red, so it cannot be confused with the orange/yellow "working" pulse.
    case 'waiting': return S.err
    case 'busy': return S.warn
    case 'idle': return S.muted
    case 'live': return S.ok
    case 'gone': return S.dim
    case 'error': return S.err
    default: return S.muted
  }
}

export const SPINNER_MS = 90

// Status is carried by colour, not by glyph shape.
//
// Spinner glyphs — braille, arcs, box-drawing — depend on the terminal font
// having them, and a missing glyph renders as a box or collapses the column.
// ● and ○ are in essentially every monospace font, so the only thing that
// animates is the colour of a dot that is always there.
//
// Shape still carries a second signal for anyone who cannot separate the
// hues: filled means the session is live, hollow means it is sitting idle.
export function statusGlyph(status) {
  return status === 'idle' ? '○' : '●'
}

// Warm pulse for "working": orange ⇄ yellow, one cycle per second. Rendered
// from the clock so no animation state is threaded through the screens — the
// caller just has to redraw at roughly SPINNER_MS.
const PULSE_MS = 1000
const PULSE_A = [255, 140, 40]   // orange
const PULSE_B = [255, 232, 130]  // yellow
const PULSE_256 = [208, 214, 220, 226, 220, 214]
const PULSE_16 = ['33', '93']

export function pulseStyle(now = Date.now()) {
  if (!hasColor) return ''
  // Sine rather than a hard alternation: a blink reads as an error state,
  // a breath reads as activity.
  const t = (Math.sin((now / PULSE_MS) * Math.PI * 2) + 1) / 2
  if (depth >= 24) {
    const c = PULSE_A.map((a, i) => Math.round(a + (PULSE_B[i] - a) * t))
    return `38;2;${c[0]};${c[1]};${c[2]}`
  }
  if (depth >= 8) return `38;5;${PULSE_256[Math.floor(now / 160) % PULSE_256.length]}`
  return PULSE_16[Math.floor(now / 400) % PULSE_16.length]
}

// Style for a status, animated where that means something.
export function statusStyleAt(status, now = Date.now()) {
  return status === 'busy' ? pulseStyle(now) : statusStyle(status)
}

// Colour for a filled gauge: calm until it matters, loud when it does.
export function gaugeStyle(frac) {
  if (!Number.isFinite(frac)) return S.dim
  if (frac >= 0.85) return S.err
  if (frac >= 0.6) return S.warn
  return S.ok
}

// Session accent colours.
//
// Claude renders an agent-color name through its own theme, and this is that
// theme's mapping — so a session tinted here is the colour Claude shows for
// it, not an approximation. purple, orange and pink have no basic-ANSI
// equivalent, hence the 256-colour indices.
//
// These are deliberately raw ANSI rather than tokens from the palette above:
// the point is to agree with Claude, not with cl.
const AGENT_SGR = {
  red: '31', green: '32', yellow: '33', blue: '34', purple: '35', cyan: '36',
  orange: '38;5;208', pink: '38;5;205',
}

// Nearest basics for terminals without a 256-colour palette.
const AGENT_SGR_16 = { orange: '33', pink: '35' }

// null when the session has no colour, so callers can fall back with `||`.
export function agentStyle(name) {
  if (!hasColor || !name || name === 'default') return null
  const sgr = AGENT_SGR[name]
  if (!sgr) return null
  if (depth < 8 && AGENT_SGR_16[name]) return AGENT_SGR_16[name]
  return sgr
}

// Subscription accounts. Two hues far enough apart to tell apart at a glance
// in a header, and deliberately not the status colours: an account is a
// setting you chose, never a state that needs attention.
// [r, g, b, xterm256, ansi16]
const ACCOUNT_P = {
  red: [233, 90, 100, 203, 91],
  amber: [235, 155, 60, 214, 93],
  yellow: [230, 200, 90, 221, 93],
  green: [140, 200, 120, 114, 92],
  teal: [110, 200, 190, 80, 96],
  blue: [110, 165, 240, 75, 94],
  purple: [180, 145, 235, 141, 95],
  pink: [230, 130, 190, 205, 95],
  grey: [140, 140, 160, 245, 90],
}

export const ACCOUNT_COLORS = Object.keys(ACCOUNT_P)

// Defaults, so the two accounts you started with keep the colours they had
// before any of this was customisable.
const ACCOUNT_DEFAULT = { max: 'red', pro: 'amber' }

export function accountStyle(id, color = null) {
  if (!hasColor) return ''
  const name = (color && ACCOUNT_P[color]) ? color : (ACCOUNT_DEFAULT[id] || 'grey')
  const c = ACCOUNT_P[name]
  if (depth >= 24) return `38;2;${c[0]};${c[1]};${c[2]};1`
  if (depth >= 8) return `38;5;${c[3]};1`
  return `${c[4]};1`
}

export function accountColorName(id, color = null) {
  return (color && ACCOUNT_P[color]) ? color : (ACCOUNT_DEFAULT[id] || 'grey')
}

export function statusLabel(status) {
  return status === 'waiting' ? 'needs you' : (status || 'unknown')
}
