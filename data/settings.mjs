// Typed access to the settings files.
//
// The registry below only describes keys cl is confident about. Any other key
// found in the file is still listed and still editable — as a generic row in
// the Defaults form, and always through the raw JSON editor. cl never drops a
// key it does not recognise.

import path from 'node:path'
import fs from 'node:fs'
import { P, exists } from './paths.mjs'
import { readJson, updateJson, writeJson, serialize } from './json.mjs'

export const SCOPES = {
  user: { id: 'user', label: 'user', file: P.settings },
  local: { id: 'local', label: 'local', file: P.settingsLocal },
}

export function load(scope = 'user') {
  const s = SCOPES[scope] || SCOPES.user
  const r = readJson(s.file, {})
  return { ...r, file: s.file, scope: s.id }
}

export function save(scope, data) {
  const s = SCOPES[scope] || SCOPES.user
  return writeJson(s.file, data)
}

export function update(scope, mutate) {
  const s = SCOPES[scope] || SCOPES.user
  return updateJson(s.file, mutate)
}

export function preview(scope, mutate) {
  const cur = load(scope)
  const next = structuredClone(cur.data ?? {})
  mutate(next)
  return { before: cur.raw ?? '', after: serialize(next), next }
}

// ── Known keys ───────────────────────────────────────────────────────
// type: 'enum' | 'bool' | 'string' | 'number' | 'object'
// Objects are edited by their own sub-editor, not by the Defaults form.

export const SETTING_DEFS = [
  { key: 'model', type: 'string', group: 'Session',
    label: 'Model', desc: 'Default model. An alias (opus, sonnet, haiku, fable) or a full model name.' },
  { key: 'effortLevel', type: 'enum', group: 'Session',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
    label: 'Effort', desc: 'How much reasoning Claude spends per turn by default.' },
  { key: 'outputStyle', type: 'string', group: 'Session',
    label: 'Output style', desc: 'Named output style applied to responses.' },
  { key: 'alwaysThinkingEnabled', type: 'bool', group: 'Session',
    label: 'Always thinking', desc: 'Keep extended thinking on for every turn.' },

  { key: 'theme', type: 'enum', group: 'Interface',
    options: ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'],
    label: 'Theme', desc: 'Colour theme for the Claude Code interface.' },
  { key: 'tui', type: 'enum', group: 'Interface', options: ['fullscreen', 'classic'],
    label: 'TUI mode', desc: 'Fullscreen takes over the terminal; classic scrolls inline.' },
  { key: 'verbose', type: 'bool', group: 'Interface',
    label: 'Verbose', desc: 'Show full turn-by-turn output rather than collapsed summaries.' },
  { key: 'spinnerTipsEnabled', type: 'bool', group: 'Interface',
    label: 'Spinner tips', desc: 'Show rotating tips while Claude is working.' },

  { key: 'inputNeededNotifEnabled', type: 'bool', group: 'Notifications',
    label: 'Input needed', desc: 'Notify when Claude is waiting on you.' },
  { key: 'agentPushNotifEnabled', type: 'bool', group: 'Notifications',
    label: 'Agent push', desc: 'Push notifications for background agent activity.' },
  { key: 'voiceEnabled', type: 'bool', group: 'Notifications',
    label: 'Voice', desc: 'Enable voice input and output.' },
  { key: 'messageIdleNotifThresholdMs', type: 'number', group: 'Notifications',
    label: 'Idle threshold', desc: 'Milliseconds of quiet before an idle notification fires.' },

  { key: 'autoUpdatesChannel', type: 'enum', group: 'Maintenance', options: ['stable', 'latest'],
    label: 'Update channel', desc: 'Which build stream to auto-update from.' },
  { key: 'cleanupPeriodDays', type: 'number', group: 'Maintenance',
    label: 'Cleanup after', desc: 'Days of transcript history to retain before Claude prunes it.' },
  { key: 'includeCoAuthoredBy', type: 'bool', group: 'Maintenance',
    label: 'Co-authored-by', desc: 'Add the Claude co-author trailer to commits.' },

  { key: 'skipDangerousModePermissionPrompt', type: 'bool', group: 'Safety',
    label: 'Skip danger prompt', desc: 'Do not ask for confirmation when starting in skip-permissions mode.' },
  { key: 'disableAllHooks', type: 'bool', group: 'Safety',
    label: 'Disable all hooks', desc: 'Master switch turning every hook off without deleting them.' },
  { key: 'apiKeyHelper', type: 'string', group: 'Safety',
    label: 'API key helper', desc: 'Command that prints an API key on stdout.' },
]

// Keys that have a dedicated editor and must not appear in the Defaults form.
export const COMPLEX_KEYS = new Set([
  'permissions', 'hooks', 'enabledPlugins', 'env', 'statusLine',
  'mcpServers', 'agents', 'plugins',
])

export function settingDef(key) {
  return SETTING_DEFS.find((d) => d.key === key) || null
}

// Everything the Defaults form should show: known keys, plus any unrecognised
// scalar key that is actually present in the file.
export function defaultsRows(data) {
  const rows = SETTING_DEFS.map((def) => ({ ...def, value: data?.[def.key], present: data ? def.key in data : false }))
  const known = new Set(SETTING_DEFS.map((d) => d.key))
  for (const key of Object.keys(data || {})) {
    if (known.has(key) || COMPLEX_KEYS.has(key)) continue
    const v = data[key]
    const type = typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : 'object'
    rows.push({ key, type, group: 'Other', label: key, desc: 'Not a key cl knows about — edit with care.', value: v, present: true, unknown: true })
  }
  return rows
}

// ── Hooks ────────────────────────────────────────────────────────────

export const HOOK_EVENTS = [
  { id: 'SessionStart', desc: 'A session starts or resumes.' },
  { id: 'SessionEnd', desc: 'A session ends.' },
  { id: 'UserPromptSubmit', desc: 'You submit a prompt, before Claude sees it.' },
  { id: 'PreToolUse', desc: 'Before a tool runs. Can block the call.' },
  { id: 'PostToolUse', desc: 'After a tool returns.' },
  { id: 'Notification', desc: 'Claude emits a notification.' },
  { id: 'Stop', desc: 'Claude finishes responding.' },
  { id: 'SubagentStop', desc: 'A subagent finishes.' },
  { id: 'PreCompact', desc: 'Before the conversation is compacted.' },
]

// Flatten settings.hooks into one row per command.
export function listHooks(data) {
  const out = []
  const hooks = data?.hooks || {}
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue
    matchers.forEach((group, gi) => {
      const list = Array.isArray(group?.hooks) ? group.hooks : []
      list.forEach((h, hi) => {
        out.push({
          id: `${event}:${gi}:${hi}`,
          event,
          matcher: group.matcher ?? null,
          groupIndex: gi,
          hookIndex: hi,
          type: h.type || 'command',
          command: h.command || '',
          timeout: h.timeout ?? null,
        })
      })
    })
  }
  return out
}

export function addHook(data, { event, matcher, command, timeout }) {
  if (!data.hooks) data.hooks = {}
  if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
  const key = matcher || undefined
  let group = data.hooks[event].find((g) => (g.matcher ?? undefined) === key)
  if (!group) {
    group = key ? { matcher: key, hooks: [] } : { hooks: [] }
    data.hooks[event].push(group)
  }
  if (!Array.isArray(group.hooks)) group.hooks = []
  const entry = { type: 'command', command }
  if (timeout) entry.timeout = timeout
  group.hooks.push(entry)
  return data
}

export function removeHook(data, hook) {
  const groups = data?.hooks?.[hook.event]
  if (!Array.isArray(groups)) return data
  const group = groups[hook.groupIndex]
  if (!group || !Array.isArray(group.hooks)) return data
  group.hooks.splice(hook.hookIndex, 1)
  if (group.hooks.length === 0) groups.splice(hook.groupIndex, 1)
  if (groups.length === 0) delete data.hooks[hook.event]
  if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks
  return data
}

export function updateHook(data, hook, patch) {
  const group = data?.hooks?.[hook.event]?.[hook.groupIndex]
  const entry = group?.hooks?.[hook.hookIndex]
  if (!entry) return data
  Object.assign(entry, patch)
  for (const k of Object.keys(patch)) if (patch[k] === null) delete entry[k]
  return data
}

// ── Permissions ──────────────────────────────────────────────────────

export const PERMISSION_LISTS = ['allow', 'ask', 'deny']
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

export function listPermissions(data) {
  const perms = data?.permissions || {}
  const out = []
  for (const list of PERMISSION_LISTS) {
    const rules = Array.isArray(perms[list]) ? perms[list] : []
    rules.forEach((rule, i) => out.push({ id: `${list}:${i}`, list, index: i, rule }))
  }
  return out
}

export function addPermission(data, list, rule) {
  if (!data.permissions) data.permissions = {}
  if (!Array.isArray(data.permissions[list])) data.permissions[list] = []
  if (!data.permissions[list].includes(rule)) data.permissions[list].push(rule)
  return data
}

export function removePermission(data, entry) {
  const arr = data?.permissions?.[entry.list]
  if (Array.isArray(arr)) {
    arr.splice(entry.index, 1)
    if (arr.length === 0) delete data.permissions[entry.list]
  }
  return data
}

export function additionalDirs(data) {
  const d = data?.permissions?.additionalDirectories
  return Array.isArray(d) ? d : []
}

// ── Plugins ──────────────────────────────────────────────────────────

// Discover installed plugins from the cache: plugins/cache/<marketplace>/<name>
export function installedPlugins() {
  const cache = path.join(P.plugins, 'cache')
  if (!exists(cache)) return []
  const out = []
  for (const market of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!market.isDirectory()) continue
    const dir = path.join(cache, market.name)
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      let desc = ''
      const manifest = path.join(dir, e.name, '.claude-plugin', 'plugin.json')
      try {
        if (exists(manifest)) desc = JSON.parse(fs.readFileSync(manifest, 'utf8')).description || ''
      } catch { /* manifest is optional */ }
      out.push({ id: `${e.name}@${market.name}`, name: e.name, marketplace: market.name, desc })
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function pluginRows(data) {
  const enabled = data?.enabledPlugins || {}
  const rows = installedPlugins().map((p) => ({ ...p, enabled: enabled[p.id] === true }))
  // Enabled entries whose plugin is no longer installed.
  for (const id of Object.keys(enabled)) {
    if (!rows.some((r) => r.id === id)) {
      const [name, marketplace = ''] = id.split('@')
      rows.push({ id, name, marketplace, desc: '', enabled: enabled[id] === true, missing: true })
    }
  }
  return rows
}

export function setPlugin(data, id, on) {
  if (!data.enabledPlugins) data.enabledPlugins = {}
  if (on) data.enabledPlugins[id] = true
  else delete data.enabledPlugins[id]
  if (Object.keys(data.enabledPlugins).length === 0) delete data.enabledPlugins
  return data
}

// ── MCP servers ──────────────────────────────────────────────────────
// User-level MCP servers live in ~/.claude.json, not settings.json.

export function loadMcp() {
  const r = readJson(P.claudeJson, {})
  const servers = r.data?.mcpServers || {}
  return {
    file: P.claudeJson,
    error: r.error,
    servers: Object.entries(servers).map(([name, cfg]) => ({ id: name, name, ...cfg })),
  }
}

export function updateMcp(mutate) {
  return updateJson(P.claudeJson, (data) => {
    if (!data.mcpServers) data.mcpServers = {}
    mutate(data.mcpServers)
    return data
  })
}

// ── Environment ──────────────────────────────────────────────────────

export function envRows(data) {
  const env = data?.env || {}
  return Object.entries(env).map(([k, v]) => ({ id: k, key: k, value: String(v) }))
}

export function setEnv(data, key, value) {
  if (!data.env) data.env = {}
  if (value === null) delete data.env[key]
  else data.env[key] = value
  if (Object.keys(data.env).length === 0) delete data.env
  return data
}

// ── Keybindings ──────────────────────────────────────────────────────

export function loadKeybindings() {
  const r = readJson(P.keybindings, {})
  return { ...r, file: P.keybindings }
}
