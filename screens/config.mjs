// Config — the persistent settings, grouped.
//
// A menu of sections, each of which pushes a sub-editor. Sub-editors implement
// the same { render, onKey } contract as a top-level screen, so the shell does
// not need to know which one is open. Escape pops back to the menu.
//
// Two things are always available: R opens the raw JSON tree for whichever
// file the current section lives in, and U switches between the user and local
// settings files.

import { S } from '../tui/theme.mjs'
import { List, confirm, chooseFrom, showText } from '../tui/widgets.mjs'
import { truncate, fit, wrap, stringWidth } from '../tui/width.mjs'
import * as Settings from '../data/settings.mjs'
import { listBackups, restoreBackup, diffLines } from '../data/json.mjs'
import { P, tildify, formatAge, formatBytes, exists } from '../data/paths.mjs'

import { DefaultsEditor } from './config/defaults.mjs'
import { HooksEditor } from './config/hooks.mjs'
import { PermissionsEditor } from './config/permissions.mjs'
import { PluginsEditor, EnvEditor, McpEditor } from './config/lists.mjs'
import { RawJsonEditor } from './config/rawjson.mjs'
import { StatuslineEditor, KeybindingsEditor, MemoryEditor } from './config/misc.mjs'

export class ConfigScreen {
  id = 'config'
  title = 'Config'

  constructor() {
    this.scope = 'user'
    this.list = new List([])
    this.editor = null
  }

  get keys() {
    if (this.editor) return this.editor.keys ?? [['esc', 'back']]
    return [['enter', 'open'], ['R', 'raw JSON'], ['U', 'user/local'], ['B', 'backups'], ['?', 'help']]
  }

  get help() {
    if (this.editor) return this.editor.help ?? []
    return [
      'enter        open the highlighted section',
      'R            raw JSON tree for this settings file',
      'U            switch between user and local settings',
      'B            browse and restore backups cl has taken',
      '',
      'Every write is atomic and keeps a backup. A settings file that',
      'is not valid JSON is never overwritten.',
    ]
  }

  onEnter() {
    this.reload()
  }

  onReturn() {
    this.reload()
  }

  reload() {
    this.doc = Settings.load(this.scope)
    this.rebuild()
    this.editor?.reload?.()
  }

  sections() {
    const d = this.doc?.data || {}
    const hooks = Settings.listHooks(d)
    const perms = Settings.listPermissions(d)
    const plugins = Settings.pluginRows(d)
    const mcp = Settings.loadMcp()
    const kb = Settings.loadKeybindings()
    const kbCount = Object.keys(kb.data?.keybindings ?? kb.data ?? {}).length

    const defaultsSet = Settings.defaultsRows(d).filter((r) => r.present)
    const eventCount = new Set(hooks.map((h) => h.event)).size

    return [
      { id: 'defaults', label: 'Defaults', make: () => new DefaultsEditor(this.scope),
        summary: defaultsSet.length ? defaultsSet.slice(0, 4).map((r) => `${r.key}=${fmt(r.value)}`).join('  ') : 'nothing set' },
      { id: 'hooks', label: 'Hooks', make: () => new HooksEditor(this.scope),
        summary: hooks.length ? `${eventCount} event${eventCount === 1 ? '' : 's'} · ${hooks.length} hook${hooks.length === 1 ? '' : 's'}` : 'none' },
      { id: 'permissions', label: 'Permissions', make: () => new PermissionsEditor(this.scope),
        summary: summarizePerms(d, perms) },
      { id: 'plugins', label: 'Plugins', make: () => new PluginsEditor(this.scope),
        summary: `${plugins.filter((p) => p.enabled).length} of ${plugins.length} enabled` },
      { id: 'mcp', label: 'MCP servers', make: () => new McpEditor(this.scope),
        summary: mcp.servers.length ? `${mcp.servers.length} configured` : 'none' },
      { id: 'statusline', label: 'Statusline', make: () => new StatuslineEditor(this.scope),
        summary: d.statusLine ? truncate(d.statusLine.command || d.statusLine.type || 'set', 46) : 'none' },
      { id: 'keybindings', label: 'Keybindings', make: () => new KeybindingsEditor(this.scope),
        summary: kbCount ? `${kbCount} custom` : 'none' },
      { id: 'env', label: 'Environment', make: () => new EnvEditor(this.scope),
        summary: Settings.envRows(d).length ? `${Settings.envRows(d).length} variable(s)` : 'none' },
      { id: 'memory', label: 'Memory', make: () => new MemoryEditor(this.scope),
        summary: exists(P.claudeMd) ? 'CLAUDE.md' : 'no CLAUDE.md' },
    ]
  }

  rebuild() {
    this.list.setItems(this.sections().map((s) => ({ ...s, selectable: true })))
  }

  headerRight() {
    if (this.editor) return `${this.scope} · ${tildify(this.doc?.file ?? '')}`
    const err = this.doc?.error ? '  ⚠ invalid JSON' : ''
    return `${this.scope} · ${tildify(this.doc?.file ?? '')}${err}`
  }

  render(app, body) {
    if (this.editor) { this.editor.render(app, body); return }
    const scr = app.screen

    if (this.doc?.error) {
      scr.put(body.x + 2, body.y, '⚠ this settings file is not valid JSON — cl will not write to it', S.err)
      scr.put(body.x + 2, body.y + 1, truncate(this.doc.error.message, body.w - 4), S.muted)
      scr.put(body.x + 2, body.y + 3, 'press R to inspect the raw file, or B to restore a backup', S.dim)
      return
    }

    const labelW = 16
    this.list.draw(scr, body.x, body.y, body.w, body.h - 3, (item, { selected }) => [
      { text: '  ' + fit(item.label, labelW), style: selected ? S.title : S.base },
      { text: truncate(item.summary, body.w - labelW - 6), style: S.muted },
    ])

    const y = body.y + body.h - 2
    scr.hline(body.x, y - 1, body.w, S.border)
    const sel = this.list.selected()
    scr.put(body.x + 2, y, truncate(descFor(sel?.id), body.w - 4), S.warn)
  }

  get textEntry() {
    return this.editor?.textEntry ?? false
  }

  async onKey(ev, app) {
    if (this.editor) {
      if (await this.editor.onKey?.(ev, app)) return true
      if (ev.name === 'escape') { this.editor = null; this.reload(); return true }
      // Swallow left/right so h/l cannot throw you out of an open editor into
      // another screen mid-edit.
      if (ev.name === 'left' || ev.name === 'right') return true
      return false
    }

    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'enter': {
        const sel = this.list.selected()
        if (!sel) return true
        if (this.doc?.error) { app.error('fix the JSON first — press R'); return true }
        this.editor = sel.make()
        this.editor.reload?.()
        return true
      }
      case 'R': {
        this.editor = new RawJsonEditor(this.doc?.file ?? P.settings)
        this.editor.reload?.()
        return true
      }
      case 'U':
        this.scope = this.scope === 'user' ? 'local' : 'user'
        this.reload()
        app.toast(`editing ${this.scope} settings`)
        return true
      case 'B':
        await this.browseBackups(app)
        return true
      case 'escape':
        app.switchTo('sessions')
        return true
    }
    return false
  }

  async browseBackups(app) {
    const all = listBackups()
    if (!all.length) { app.toast('no backups yet', S.warn); return }
    const choice = await chooseFrom(app, {
      title: 'Backups',
      filterable: true,
      items: all.map((b) => ({
        value: b.path,
        label: b.target,
        hint: `${formatAge(b.mtime)} ago · ${formatBytes(b.size)}`,
      })),
    })
    if (!choice) return
    const backup = all.find((b) => b.path === choice)
    const target = backup.target === 'settings.json' ? P.settings
      : backup.target === 'settings.local.json' ? P.settingsLocal
      : backup.target === '.claude.json' ? P.claudeJson
      : backup.target === 'keybindings.json' ? P.keybindings
      : null
    if (!target) { app.error(`cl does not know where to restore ${backup.target}`); return }

    const { readText } = await import('../data/json.mjs')
    const before = readText(target) ?? ''
    const after = readText(backup.path) ?? ''
    if (before === after) { app.toast('backup is identical to the current file'); return }

    const lines = diffLines(before, after).map((d) => ({
      text: d.kind + ' ' + d.text,
      style: d.kind === '+' ? S.ok : d.kind === '-' ? S.err : S.dim,
    }))
    await showText(app, { title: `restore ${backup.target} — preview`, lines })

    const ok = await confirm(app, {
      title: 'Restore backup',
      message: `Overwrite ${backup.target} with this backup?`,
      detail: 'The current file is backed up first.',
      danger: true,
      yes: 'Restore',
    })
    if (!ok) return
    try {
      restoreBackup(backup.path, target)
      this.reload()
      app.toast('restored')
    } catch (err) {
      app.error(err.message)
    }
  }
}

function fmt(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (v === null || v === undefined) return '—'
  return String(v)
}

function summarizePerms(data, perms) {
  const counts = Settings.PERMISSION_LISTS
    .map((l) => [l, perms.filter((p) => p.list === l).length])
    .filter(([, n]) => n > 0)
    .map(([l, n]) => `${n} ${l}`)
  const mode = data?.permissions?.defaultMode
  const bits = counts.length ? counts : ['no rules']
  if (mode) bits.push(`mode ${mode}`)
  return bits.join(' · ')
}

function descFor(id) {
  switch (id) {
    case 'defaults': return 'Model, effort, theme and other scalar settings.'
    case 'hooks': return 'Commands Claude runs at lifecycle events. Portable across machines via the shim.'
    case 'permissions': return 'Rules that allow, ask about, or deny tool calls without prompting.'
    case 'plugins': return 'Which installed plugins load. Takes effect on the next session.'
    case 'mcp': return 'Model Context Protocol servers, stored in ~/.claude.json.'
    case 'statusline': return 'Command that renders the status line inside Claude Code.'
    case 'keybindings': return 'Custom key bindings from ~/.claude/keybindings.json.'
    case 'env': return 'Environment variables exported into every session.'
    case 'memory': return 'CLAUDE.md files loaded as persistent instructions.'
    default: return ''
  }
}
