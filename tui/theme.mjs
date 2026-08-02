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

// Named status colours for session state, hook events, etc.
export function statusStyle(status) {
  switch (status) {
    case 'busy': return S.warn
    case 'idle': return S.ok
    case 'live': return S.ok
    case 'gone': return S.dim
    case 'error': return S.err
    default: return S.muted
  }
}
