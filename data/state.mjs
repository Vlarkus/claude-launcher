// cl's own state: pins, launch profiles, and what you used last.
//
// A pin is a pointer and nothing more — project folder, session id, and a
// label for display. Resuming a pin runs exactly the same code as resuming a
// recent session. An earlier version of this launcher stored richer pin data
// and let it feed the new-session path, which broke launching new sessions;
// keeping pins inert is the fix.

import { P, ensureDir } from './paths.mjs'
import { readJson, writeJson } from './json.mjs'

const EMPTY = {
  version: 2,
  pins: [],
  profiles: {},
  hookPresets: {},
  lastProfile: null,
  lastLaunch: null,
  ui: { screen: 'sessions' },
}

let cache = null

export function loadState() {
  if (cache) return cache
  const r = readJson(P.state, EMPTY)
  const data = r.error ? structuredClone(EMPTY) : { ...structuredClone(EMPTY), ...(r.data || {}) }
  if (!Array.isArray(data.pins)) data.pins = []
  if (!data.profiles || typeof data.profiles !== 'object') data.profiles = {}
  cache = data
  return cache
}

export function saveState() {
  if (!cache) return
  ensureDir(P.launcher)
  writeJson(P.state, cache, { backup: false })
}

export function pinKey(session) {
  return `${session.project}/${session.id}`
}

export function isPinned(session) {
  const st = loadState()
  return st.pins.some((p) => p.project === session.project && p.sessionId === session.id)
}

export function togglePin(session, label) {
  const st = loadState()
  const i = st.pins.findIndex((p) => p.project === session.project && p.sessionId === session.id)
  if (i >= 0) st.pins.splice(i, 1)
  else st.pins.push({ project: session.project, sessionId: session.id, label: label || null })
  saveState()
  return i < 0
}

export function renamePin(session, label) {
  const st = loadState()
  const pin = st.pins.find((p) => p.project === session.project && p.sessionId === session.id)
  if (pin) { pin.label = label; saveState() }
}

// Drop pins whose transcript is gone.
export function reconcilePins(sessions) {
  const st = loadState()
  const alive = new Set(sessions.map((s) => `${s.project}/${s.id}`))
  const before = st.pins.length
  st.pins = st.pins.filter((p) => alive.has(`${p.project}/${p.sessionId}`))
  if (st.pins.length !== before) saveState()
  return before - st.pins.length
}

// ── Launch profiles ──────────────────────────────────────────────────

export function listProfiles() {
  const st = loadState()
  return Object.entries(st.profiles).map(([name, cfg]) => ({ id: name, name, ...cfg }))
}

export function saveProfile(name, config) {
  const st = loadState()
  st.profiles[name] = structuredClone(config)
  st.lastProfile = name
  saveState()
}

export function deleteProfile(name) {
  const st = loadState()
  delete st.profiles[name]
  if (st.lastProfile === name) st.lastProfile = null
  saveState()
}

export function getProfile(name) {
  const st = loadState()
  return st.profiles[name] ? structuredClone(st.profiles[name]) : null
}

// ── Hook presets ─────────────────────────────────────────────────────
// A preset is a complete settings.hooks object. Applying one replaces the
// hooks section wholesale, which is why it always goes through a diff.

export function listHookPresets() {
  const st = loadState()
  return Object.entries(st.hookPresets || {}).map(([name, hooks]) => ({
    id: name,
    name,
    hooks,
    events: Object.keys(hooks || {}),
    count: Object.values(hooks || {})
      .flat()
      .reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.length : 0), 0),
  }))
}

export function getHookPreset(name) {
  const st = loadState()
  return st.hookPresets?.[name] ? structuredClone(st.hookPresets[name]) : null
}

export function saveHookPreset(name, hooks) {
  const st = loadState()
  if (!st.hookPresets) st.hookPresets = {}
  st.hookPresets[name] = structuredClone(hooks ?? {})
  saveState()
}

export function deleteHookPreset(name) {
  const st = loadState()
  delete st.hookPresets?.[name]
  saveState()
}

export function rememberLaunch(config) {
  const st = loadState()
  st.lastLaunch = structuredClone(config)
  saveState()
}

export function lastLaunch() {
  return loadState().lastLaunch
}
