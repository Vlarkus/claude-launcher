// Display width of text in terminal cells.
//
// Session titles and last-prompt previews come from arbitrary user text, so
// this has to cope with CJK, emoji and combining marks or the whole grid
// shears sideways. Ranges below are the wide/fullwidth blocks from Unicode
// EastAsianWidth plus the emoji planes — enough to keep columns aligned
// without shipping a full width table.

const ZERO = [
  [0x0300, 0x036f], // combining diacritics
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0eb1, 0x0eb1],
  [0x200b, 0x200f], // zero-width space .. RLM
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f],
]

const WIDE = [
  [0x1100, 0x115f], // hangul jamo
  [0x2e80, 0x303e], // CJK radicals, kangxi
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // hangul syllables
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

function inRanges(cp, ranges) {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < ranges[mid][0]) hi = mid - 1
    else if (cp > ranges[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

export { asText }

export function charWidth(cp) {
  if (cp === 0x200d) return 0 // ZWJ — emoji sequences collapse to one cell
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

// These four are the choke point for every piece of text that reaches the
// screen, and they are called with values from settings files, session
// transcripts and caller-built row objects. Coercing here means one bad value
// renders as text instead of crashing the whole launcher.
function asText(v) {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    // A { text, style } span passed where a plain string was expected.
    if (typeof v.text === 'string') return v.text
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

export function stringWidth(str) {
  const s = asText(str)
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}

// Cut `str` to at most `max` cells, appending an ellipsis when it does not fit.
export function truncate(str, max, ellipsis = '…') {
  const s = asText(str)
  if (!Number.isFinite(max) || max <= 0) return ''
  if (stringWidth(s) <= max) return s
  const budget = max - stringWidth(ellipsis)
  if (budget <= 0) return ''
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > budget) break
    out += ch
    w += cw
  }
  return out + ellipsis
}

// Greedy word wrap to `width` cells. Long words are hard-broken.
export function wrap(str, width) {
  if (!Number.isFinite(width) || width <= 0) return []
  const lines = []
  for (const para of asText(str).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + ' ' + word : word
      if (stringWidth(candidate) <= width) { line = candidate; continue }
      if (line) { lines.push(line); line = '' }
      let rest = word
      while (stringWidth(rest) > width) {
        let cut = ''
        for (const ch of rest) {
          if (stringWidth(cut + ch) > width) break
          cut += ch
        }
        lines.push(cut)
        rest = rest.slice(cut.length)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}

// Pad to exactly `width` cells, truncating when too long. `align` is
// 'left' | 'right' | 'center'.
export function fit(str, width, align = 'left') {
  if (!Number.isFinite(width) || width <= 0) return ''
  const s = truncate(str, width)
  const gap = width - stringWidth(s)
  if (gap <= 0) return s
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') {
    const l = Math.floor(gap / 2)
    return ' '.repeat(l) + s + ' '.repeat(gap - l)
  }
  return s + ' '.repeat(gap)
}
