// Stats — everything the transcripts can tell you about how you use Claude.
//
// One scrollable page rather than sub-tabs: the point is to see it all at
// once. Every chart is single-series and one hue, with the numbers printed
// beside the bars, so nothing here depends on colour to be read.
//
// Cost is deliberately absent. Transcripts record tokens, not money, so any
// dollar figure would come from a hardcoded price table that drifts silently.

import { S } from '../tui/theme.mjs'
import { truncate, fit, stringWidth } from '../tui/width.mjs'
import { sparkline, histogram, barList, statRow, fmtCount, fmtDuration } from '../tui/charts.mjs'
import * as Usage from '../data/usage.mjs'
import * as Sessions from '../data/sessions.mjs'
import { shortProject, formatAge } from '../data/paths.mjs'

export class StatsScreen {
  id = 'stats'
  title = 'Stats'
  keys = [['j/k', 'scroll'], ['r', 'recompute'], ['`', 'bar'], ['?', 'help']]
  help = [
    'j / k        scroll',
    'ctrl-d / -u  page',
    'gg / G       top / bottom',
    'r            re-read every transcript',
    '`            toggle the summary bar shown on all screens',
    '',
    'Figures come from the usage block on every assistant message, so they',
    'are what was actually spent — including subagent sidechains.',
    '',
    'The 5-hour figure is a rolling window over your own history, NOT a',
    'rate-limit reading. Claude does not record its limits locally, so cl',
    'cannot show how much of a quota is left.',
    '',
    'Cost is not shown: transcripts record tokens, not money.',
  ]

  constructor() {
    this.offset = 0
    this.contentH = 0
  }

  onEnter() {
    this.agg = Usage.collect()
    this.features = Usage.featureUsage()
  }

  // Project folder names encode a path lossily, so decoding two different
  // repos can produce the same short label — "beta-new-website" and
  // "acme-new-website" both became "new/website". Sessions record their real
  // cwd, so ask them; only fall back to the decode when a project has no
  // readable session, and keep enough of the folder name to stay unique.
  projectLabel(dir) {
    this._labels ??= new Map()
    if (this._labels.has(dir)) return this._labels.get(dir)
    let label
    const cwd = Sessions.projectCwd(dir, null)
    if (cwd && !cwd.includes('--')) label = shortProject(cwd) || dir
    else label = dir.replace(/^[A-Za-z]--/, '').replace(/-/g, '/')
    this._labels.set(dir, label)
    return label
  }

  onReturn() {
    Usage.invalidate()
    this.agg = Usage.collect()
  }

  onTick() {
    // Cheap: collect() only re-reads files whose size or mtime moved.
    const next = Usage.collect({ maxAgeMs: 10_000 })
    if (next === this.agg) return false
    this.agg = next
    return true
  }

  headerRight() {
    if (!this.agg) return ''
    const span = this.agg.first ? fmtDuration(Date.now() - this.agg.first) : ''
    return `${fmtCount(this.agg.messages)} messages over ${span}`
  }

  render(app, body) {
    const scr = app.screen
    const agg = this.agg ?? (this.agg = Usage.collect())
    const x = body.x + 2
    const w = body.w - 4
    let y = body.y - this.offset

    const heading = (text) => {
      if (y >= body.y && y < body.y + body.h) scr.put(x, y, text, S.heading)
      y += 1
    }
    const gap = (n = 1) => { y += n }

    const win = Usage.window(agg)
    const day = Usage.today(agg)

    // ── Totals. A headline number is the right form here; a one-bar chart
    // would say less than the number itself.
    statRow(scr, x, y, w, [
      { value: fmtCount(agg.out), label: 'output tokens', hint: 'all time' },
      { value: fmtCount(agg.messages), label: 'assistant turns' },
      { value: String(agg.sessionCount), label: 'sessions' },
      { value: fmtCount(agg.tools), label: 'tool calls' },
    ])
    y += 4

    statRow(scr, x, y, w, [
      { value: fmtCount(win.out), label: `last ${Usage.WINDOW_HOURS}h`, hint: `${win.msgs} turns` },
      { value: fmtCount(day.out), label: 'today', hint: `${day.msgs} turns` },
      // Cumulative across requests: the same context is re-read every turn, so
      // this is far larger than the conversation. Said plainly rather than
      // left to look like a total context size.
      { value: fmtCount(agg.cacheRead), label: 'cached input', hint: 'summed per request' },
      { value: String(agg.sidechainMsgs), label: 'subagent turns' },
    ])
    y += 4

    // ── Recent activity
    heading('OUTPUT TOKENS · LAST 12 HOURS')
    const spark = Usage.series(agg, { hours: 12, points: Math.max(10, Math.min(w - 12, 96)) })
    if (y >= body.y && y < body.y + body.h) {
      const line = sparkline(spark)
      scr.put(x, y, line, S.accent)
      const peak = Math.max(...spark)
      // Label the extreme only — a number on every point goes unread.
      scr.put(x + stringWidth(line) + 2, y, `peak ${fmtCount(peak)}`, S.dim)
    }
    y += 1
    if (y >= body.y && y < body.y + body.h) {
      scr.put(x, y, '12h ago', S.dim)
      scr.put(x + Math.max(0, spark.length - 3), y, 'now', S.dim)
    }
    gap(2)

    // ── Daily
    heading('TURNS PER DAY · LAST 30 DAYS')
    const days = Usage.byDay(agg, 30)
    const dayVals = days.map((d) => d.msgs)
    const peakDay = dayVals.indexOf(Math.max(...dayVals))
    // Label every seventh day with its date; a label per column would be
    // unreadable, and one character of a date is meaningless.
    histogram(scr, x, y, Math.min(w, days.length), 6, dayVals, {
      style: S.accent,
      highlight: peakDay,
      labels: days.map((d, i) => (i % 7 === 0 ? `${d.date.getMonth() + 1}/${d.date.getDate()}` : '')),
    })
    y += 8
    if (y - 1 >= body.y && y - 1 < body.y + body.h && days[peakDay]) {
      scr.put(x, y - 1, `busiest: ${days[peakDay].date.toLocaleDateString()} — ${days[peakDay].msgs} turns`, S.dim)
    }
    gap(1)

    // ── Hour of day
    heading('WHEN YOU WORK · TURNS BY HOUR, ALL TIME')
    const hours = Usage.byHourOfDay(agg)
    const busiestHour = hours.indexOf(Math.max(...hours))
    histogram(scr, x, y, Math.min(w, 24), 5, hours, {
      style: S.accent,
      highlight: busiestHour,
      labels: hours.map((_, i) => (i % 6 === 0 ? String(i).padStart(2, '0') : '')),
    })
    y += 7
    if (y - 1 >= body.y && y - 1 < body.y + body.h) {
      scr.put(x, y - 1, `busiest hour: ${String(busiestHour).padStart(2, '0')}:00`, S.dim)
    }
    gap(1)

    // ── Breakdowns
    const half = Math.floor((w - 4) / 2)

    heading('TOP PROJECTS · OUTPUT TOKENS')
    const projects = Usage.topEntries(agg.byProject, 8).map((e) => ({
      label: this.projectLabel(e.key),
      value: e.value,
    }))
    y += barList(scr, x, y, w, projects, { labelW: Math.min(28, half), format: fmtCount })
    gap(2)

    heading('TOP TOOLS · CALLS')
    const tools = Usage.topEntries(agg.byTool, 8, 'n').map((e) => ({ label: e.key, value: e.value }))
    y += barList(scr, x, y, w, tools, { labelW: Math.min(28, half), format: fmtCount })
    gap(2)

    heading('MODELS · OUTPUT TOKENS')
    const models = Usage.topEntries(agg.byModel, 6).map((e) => ({
      label: e.key.replace(/^claude-/, ''),
      value: e.value,
    }))
    y += barList(scr, x, y, w, models, { labelW: Math.min(28, half), format: fmtCount })
    gap(2)

    const feat = this.features ?? (this.features = Usage.featureUsage())
    if (feat.skills.length) {
      heading('SKILLS · INVOCATIONS')
      y += barList(scr, x, y, w, feat.skills.slice(0, 8).map((s) => ({ label: s.key, value: s.value })),
        { labelW: Math.min(34, half + 6), format: fmtCount })
      gap(2)
    }
    if (feat.plugins.length) {
      heading('PLUGINS · INVOCATIONS')
      y += barList(scr, x, y, w, feat.plugins.slice(0, 8).map((p) => ({ label: p.key.split('@')[0], value: p.value })),
        { labelW: Math.min(34, half + 6), format: fmtCount })
      gap(2)
    }

    if (feat.startups) {
      if (y >= body.y && y < body.y + body.h) {
        scr.put(x, y, `${feat.startups} launches since ${feat.firstToken ? new Date(feat.firstToken).toLocaleDateString() : 'first use'}`, S.dim)
      }
      y += 1
    }

    // Total height, for clamping the scroll.
    this.contentH = y + this.offset - body.y

    // Scroll position, when there is more than fits.
    if (this.contentH > body.h) {
      const frac = this.offset / Math.max(1, this.contentH - body.h)
      const barY = body.y + Math.round(frac * (body.h - 1))
      for (let i = 0; i < body.h; i++) {
        scr.put(body.x + body.w - 1, body.y + i, i === barY - body.y ? '┃' : '│', i === barY - body.y ? S.accent : S.dim)
      }
    }
  }

  #clamp(app) {
    const max = Math.max(0, this.contentH - (app.screen.rows - 3))
    this.offset = Math.max(0, Math.min(this.offset, max))
  }

  async onMouse(m, app) {
    if (m.wheel) {
      this.offset += m.wheel === 'up' ? -3 : 3
      this.#clamp(app)
      return true
    }
    return false
  }

  async onKey(ev, app) {
    const page = app.screen.rows - 6
    switch (ev.name) {
      case 'down': this.offset += 1; this.#clamp(app); return true
      case 'up': this.offset -= 1; this.#clamp(app); return true
      case 'pagedown': this.offset += page; this.#clamp(app); return true
      case 'pageup': this.offset -= page; this.#clamp(app); return true
      case 'home': this.offset = 0; return true
      case 'end': this.offset = Math.max(0, this.contentH); this.#clamp(app); return true
      case 'r':
        Usage.invalidate()
        this.agg = Usage.collect({ maxAgeMs: 0 })
        this.features = Usage.featureUsage()
        app.toast(`recomputed — ${this.agg.rescanned} transcript(s) re-read`)
        return true
      case 'escape': app.switchTo('dispatch'); return true
    }
    return false
  }
}
