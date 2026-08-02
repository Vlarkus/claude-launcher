// Terminal charts.
//
// Every chart here is single-series and drawn in one hue. Identity is carried
// by the row label and the value column beside it, never by colour — which
// keeps them readable without colour, avoids double-encoding length as hue,
// and means no categorical palette is shipped at all.
//
// Status colours (ok/warn/err) stay reserved for things that actually mean a
// state, like how full a context window is. They are never used as series
// colours.

import { S } from './theme.mjs'
import { fit, truncate, stringWidth } from './width.mjs'

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const VBAR = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Compact inline series. Returns a string; the caller styles it.
export function sparkline(values, { max = null } = {}) {
  if (!values?.length) return ''
  const top = max ?? Math.max(...values)
  if (!top) return SPARK[0].repeat(values.length)
  return values.map((v) => {
    const i = Math.round((Math.max(0, v) / top) * (SPARK.length - 1))
    return SPARK[Math.min(SPARK.length - 1, i)]
  }).join('')
}

// Vertical histogram. `h` rows tall; each column is one value. The axis is a
// solid hairline one shade off the surface — never dashed.
export function histogram(scr, x, y, w, h, values, {
  style = S.accent,
  axis = true,
  labels = null,        // array of single chars under each column
  highlight = -1,       // index drawn in the emphasis colour
} = {}) {
  if (!values?.length || w <= 0 || h <= 0) return
  const plotH = axis ? h - (labels ? 2 : 1) : h
  if (plotH <= 0) return
  const n = Math.min(values.length, w)
  const max = Math.max(...values, 1)

  for (let i = 0; i < n; i++) {
    const v = Math.max(0, values[i])
    const filled = (v / max) * plotH
    const whole = Math.floor(filled)
    const rest = Math.round((filled - whole) * 8)
    const st = i === highlight ? S.title : style

    for (let r = 0; r < plotH; r++) {
      const rowFromBottom = plotH - 1 - r
      let ch = ' '
      if (rowFromBottom < whole) ch = '█'
      else if (rowFromBottom === whole && rest > 0) ch = VBAR[rest]
      if (ch !== ' ') scr.put(x + i, y + r, ch, st)
    }
  }

  if (axis) {
    scr.put(x, y + plotH, '─'.repeat(n), S.border)
    if (labels) {
      // Labels may be multi-character and are drawn at their own column, so
      // the caller is responsible for spacing them far enough apart. Anything
      // that would run past the plot is dropped rather than clipped.
      for (let i = 0; i < n; i++) {
        const text = labels[i]
        if (!text) continue
        if (i + stringWidth(text) > n) continue
        scr.put(x + i, y + plotH + 1, text, S.dim)
      }
    }
  }
}

// Horizontal bars with a label column and a value column. The value column is
// the table view — every number is readable without decoding a bar.
export function barList(scr, x, y, w, rows, {
  labelW = 20,
  valueW = 9,
  style = S.accent,
  format = (v) => String(v),
  max = null,
  maxRows = null,
} = {}) {
  const list = maxRows ? rows.slice(0, maxRows) : rows
  if (!list.length) return 0
  const top = max ?? Math.max(...list.map((r) => r.value), 1)
  const barW = Math.max(4, w - labelW - valueW - 2)

  list.forEach((row, i) => {
    const yy = y + i
    scr.put(x, yy, fit(row.label, labelW), S.muted)
    const filled = Math.round((Math.max(0, row.value) / top) * barW)
    // One hue for every bar: these categories have no natural order, so a
    // value ramp would encode length twice and burn the only free channel.
    if (filled > 0) scr.put(x + labelW + 1, yy, '▇'.repeat(filled), style)
    scr.put(x + labelW + 1 + barW + 1, yy, fit(format(row.value), valueW, 'right'), S.base)
  })
  return list.length
}

// A headline figure with a caption. The number is the chart — a one-bar bar
// chart would say less.
export function statTile(scr, x, y, w, { value, label, hint = '', style = S.title }) {
  scr.put(x, y, truncate(String(value), w), style)
  scr.put(x, y + 1, truncate(label, w), S.muted)
  if (hint) scr.put(x, y + 2, truncate(hint, w), S.dim)
  return 3
}

// Lay stat tiles out in a row, evenly spaced.
export function statRow(scr, x, y, w, tiles, { gap = 3 } = {}) {
  if (!tiles.length) return 0
  const each = Math.floor((w - gap * (tiles.length - 1)) / tiles.length)
  tiles.forEach((t, i) => statTile(scr, x + i * (each + gap), y, each, t))
  return 3
}

export function fmtCount(n) {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const mins = ms / 60000
  if (mins < 60) return `${Math.round(mins)}m`
  const hours = mins / 60
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`
  return `${Math.round(hours / 24)}d`
}
