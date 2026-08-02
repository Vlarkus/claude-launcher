// Token usage aggregated from transcripts.
//
// Every assistant message carries a timestamp and a `usage` block, so real
// figures are available locally — no API call, no guessing. What is *not*
// recorded is cost: there is no costUSD field anywhere, so cl reports tokens
// and leaves money alone rather than inventing it from a price table that
// would drift.
//
// Everything is bucketed into five-minute slots. One structure then answers
// every question the stats screens ask: a rolling window is a slice of recent
// buckets, a day is a group of them, an hour-of-day histogram is a regroup.
//
// Scanning 76MB takes ~0.4s, so the first collect is cheap and later ones are
// nearly free: per-file aggregates are cached on (size, mtime), and only files
// that actually changed are re-read.

import fs from 'node:fs'
import path from 'node:path'
import { P, exists } from './paths.mjs'

export const BUCKET_MS = 5 * 60 * 1000
export const WINDOW_HOURS = 5

const fileCache = new Map() // path -> { size, mtime, agg }
let combined = null
let combinedAt = 0

function emptyAgg() {
  return {
    buckets: new Map(),   // bucketIndex -> { out, inp, cacheRead, cacheCreate, msgs, tools }
    byModel: new Map(),   // model -> { out, msgs }
    byTool: new Map(),    // tool  -> count
    byProject: new Map(), // project dir -> { out, msgs }
    sidechainMsgs: 0,
    sessions: new Set(),
    first: null,
    last: null,
  }
}

function bump(map, key, fields) {
  let v = map.get(key)
  if (!v) { v = {}; map.set(key, v) }
  for (const [k, n] of Object.entries(fields)) v[k] = (v[k] ?? 0) + n
  return v
}

function scanFile(file, project) {
  const agg = emptyAgg()
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return agg }

  for (const line of text.split('\n')) {
    // Cheap reject before the parse — most lines are not assistant turns.
    if (line.length < 40 || line.indexOf('"assistant"') === -1) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'assistant') continue

    const m = o.message || {}
    const u = m.usage
    if (!u) continue

    const ts = Date.parse(o.timestamp)
    if (!Number.isFinite(ts)) continue

    const out = u.output_tokens || 0
    const inp = u.input_tokens || 0
    const cacheRead = u.cache_read_input_tokens || 0
    const cacheCreate = u.cache_creation_input_tokens || 0

    let tools = 0
    for (const b of m.content || []) {
      if (b && b.type === 'tool_use') {
        tools++
        bump(agg.byTool, b.name || 'unknown', { n: 1 })
      }
    }

    bump(agg.buckets, Math.floor(ts / BUCKET_MS), { out, inp, cacheRead, cacheCreate, msgs: 1, tools })
    if (m.model) bump(agg.byModel, m.model, { out, msgs: 1 })
    bump(agg.byProject, project, { out, msgs: 1 })
    if (o.isSidechain) agg.sidechainMsgs++
    if (o.sessionId) agg.sessions.add(o.sessionId)

    if (agg.first === null || ts < agg.first) agg.first = ts
    if (agg.last === null || ts > agg.last) agg.last = ts
  }
  return agg
}

function mergeInto(target, src) {
  for (const [k, v] of src.buckets) bump(target.buckets, k, v)
  for (const [k, v] of src.byModel) bump(target.byModel, k, v)
  for (const [k, v] of src.byTool) bump(target.byTool, k, v)
  for (const [k, v] of src.byProject) bump(target.byProject, k, v)
  target.sidechainMsgs += src.sidechainMsgs
  for (const s of src.sessions) target.sessions.add(s)
  if (src.first !== null && (target.first === null || src.first < target.first)) target.first = src.first
  if (src.last !== null && (target.last === null || src.last > target.last)) target.last = src.last
}

// Every transcript, including subagent sidechains — those are real API usage.
function allTranscripts() {
  const out = []
  if (!exists(P.projects)) return out
  for (const project of fs.readdirSync(P.projects)) {
    const dir = path.join(P.projects, project)
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      let entries
      try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(cur, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name.endsWith('.jsonl')) out.push({ file: full, project })
      }
    }
  }
  return out
}

// Returns the merged aggregate. Re-reads only files whose size or mtime moved.
export function collect({ maxAgeMs = 15_000 } = {}) {
  if (combined && Date.now() - combinedAt < maxAgeMs) return combined

  const seen = new Set()
  let rescanned = 0
  const total = emptyAgg()

  for (const { file, project } of allTranscripts()) {
    seen.add(file)
    let st
    try { st = fs.statSync(file) } catch { continue }
    const hit = fileCache.get(file)
    let agg
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
      agg = hit.agg
    } else {
      agg = scanFile(file, project)
      fileCache.set(file, { size: st.size, mtime: st.mtimeMs, agg })
      rescanned++
    }
    mergeInto(total, agg)
  }
  for (const k of [...fileCache.keys()]) if (!seen.has(k)) fileCache.delete(k)

  total.rescanned = rescanned
  total.messages = 0
  total.out = 0
  total.inp = 0
  total.cacheRead = 0
  total.cacheCreate = 0
  total.tools = 0
  for (const v of total.buckets.values()) {
    total.messages += v.msgs ?? 0
    total.out += v.out ?? 0
    total.inp += v.inp ?? 0
    total.cacheRead += v.cacheRead ?? 0
    total.cacheCreate += v.cacheCreate ?? 0
    total.tools += v.tools ?? 0
  }
  total.sessionCount = total.sessions.size

  combined = total
  combinedAt = Date.now()
  return total
}

export function invalidate() {
  combined = null
}

// ── Queries ──────────────────────────────────────────────────────────

function sumRange(agg, fromMs, toMs = Date.now()) {
  const from = Math.floor(fromMs / BUCKET_MS)
  const to = Math.floor(toMs / BUCKET_MS)
  const acc = { out: 0, inp: 0, cacheRead: 0, cacheCreate: 0, msgs: 0, tools: 0 }
  for (const [k, v] of agg.buckets) {
    if (k < from || k > to) continue
    for (const f of Object.keys(acc)) acc[f] += v[f] ?? 0
  }
  return acc
}

// Rolling window, not a rate-limit reading. Claude does not record its usage
// limits locally, so this is "what you actually spent in the last N hours" and
// is labelled that way — never as a quota.
export function window(agg, hours = WINDOW_HOURS) {
  return sumRange(agg, Date.now() - hours * 3600_000)
}

export function today(agg) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return sumRange(agg, d.getTime())
}

// Buckets over the last `hours`, as a dense series for a sparkline.
export function series(agg, { hours = 12, points = 48, field = 'out' } = {}) {
  const now = Date.now()
  const from = now - hours * 3600_000
  const span = (now - from) / points
  const out = new Array(points).fill(0)
  for (const [k, v] of agg.buckets) {
    const t = k * BUCKET_MS
    if (t < from || t > now) continue
    const i = Math.min(points - 1, Math.floor((t - from) / span))
    out[i] += v[field] ?? 0
  }
  return out
}

// One entry per local day, oldest first.
export function byDay(agg, days = 30) {
  const map = new Map()
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const first = now.getTime() - (days - 1) * 86400_000
  for (const [k, v] of agg.buckets) {
    const t = k * BUCKET_MS
    if (t < first) continue
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    const key = d.getTime()
    bump(map, key, v)
  }
  const out = []
  for (let i = 0; i < days; i++) {
    const key = first + i * 86400_000
    const v = map.get(key) ?? {}
    out.push({ date: new Date(key), out: v.out ?? 0, msgs: v.msgs ?? 0, tools: v.tools ?? 0 })
  }
  return out
}

// 24 slots, local hour of day, summed over the whole history.
export function byHourOfDay(agg) {
  const out = new Array(24).fill(0)
  for (const [k, v] of agg.buckets) {
    const h = new Date(k * BUCKET_MS).getHours()
    out[h] += v.msgs ?? 0
  }
  return out
}

export function topEntries(map, n = 8, field = 'out') {
  return [...map.entries()]
    .map(([key, v]) => ({ key, value: typeof v === 'object' ? (v[field] ?? v.n ?? 0) : v, raw: v }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

// Skill and plugin counters Claude keeps in ~/.claude.json.
export function featureUsage() {
  const out = { skills: [], plugins: [], startups: 0, firstToken: null }
  try {
    const d = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
    out.startups = d.numStartups ?? 0
    out.firstToken = d.claudeCodeFirstTokenDate ? Date.parse(d.claudeCodeFirstTokenDate) : null
    for (const [k, v] of Object.entries(d.skillUsage ?? {})) {
      if (v?.usageCount) out.skills.push({ key: k, value: v.usageCount, at: v.lastUsedAt })
    }
    for (const [k, v] of Object.entries(d.pluginUsage ?? {})) {
      if (v?.usageCount) out.plugins.push({ key: k, value: v.usageCount, at: v.lastUsedAt })
    }
    out.skills.sort((a, b) => b.value - a.value)
    out.plugins.sort((a, b) => b.value - a.value)
  } catch { /* optional */ }
  return out
}
