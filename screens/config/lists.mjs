// Three list-shaped editors: plugins, environment variables, MCP servers.
//
// Plugins and env are toggles and key/value pairs, so they get the full width.
// An MCP server has a command, arguments and environment worth reading, so it
// gets a preview pane.

import { S } from '../../tui/theme.mjs'
import { List, confirm, promptText, chooseFrom, checkbox } from '../../tui/widgets.mjs'
import { truncate, fit, wrap } from '../../tui/width.mjs'
import * as Settings from '../../data/settings.mjs'
import { tildify } from '../../data/paths.mjs'
import { Editor } from './base.mjs'

// ── Plugins ──────────────────────────────────────────────────────────

export class PluginsEditor extends Editor {
  keys = [['space', 'toggle'], ['esc', 'back']]
  help = [
    'space        enable or disable the plugin',
    '',
    'Plugin enablement is persistent — it is written to settings.json and',
    'applies from the next session onward, not to sessions already running.',
    'A plugin marked "not installed" is enabled in settings but missing from',
    'the plugin cache.',
  ]

  constructor(scope) {
    super(scope)
    this.list = new List([])
  }

  reload() {
    super.reload()
    this.list.setItems(Settings.pluginRows(this.data).map((p) => ({ ...p, selectable: true })))
  }

  render(app, body) {
    const scr = app.screen
    this.list.draw(scr, body.x, body.y, body.w, body.h - 3, (p, { selected, width }) => [
      { text: '  ' + checkbox(p.enabled) + ' ', style: p.enabled ? S.ok : S.dim },
      { text: fit(p.name, 22), style: p.missing ? S.err : (selected ? S.title : S.base) },
      { text: truncate(p.missing ? 'not installed' : (p.desc || p.marketplace), width - 28), style: S.muted },
    ])
    const y = body.y + body.h - 2
    scr.hline(body.x, y - 1, body.w, S.border)
    const n = this.list.items.filter((p) => p.enabled).length
    scr.put(body.x + 2, y, `${n} of ${this.list.items.length} enabled — changes apply to the next session`, S.warn)
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'space': {
        const p = this.list.selected()
        if (!p) return true
        await this.apply(app, (d) => Settings.setPlugin(d, p.id, !p.enabled),
          `${p.name} ${p.enabled ? 'disabled' : 'enabled'}`)
        this.reload()
        return true
      }
    }
    return false
  }
}

// ── Environment ──────────────────────────────────────────────────────

export class EnvEditor extends Editor {
  keys = [['a', 'add'], ['e', 'edit'], ['x', 'delete'], ['esc', 'back']]
  help = [
    'a            add a variable',
    'e            edit the value',
    'x            delete it',
    '',
    'These are exported into every Claude session started on this machine.',
  ]

  constructor(scope) {
    super(scope)
    this.list = new List([])
  }

  reload() {
    super.reload()
    const rows = Settings.envRows(this.data).map((r) => ({ ...r, selectable: true }))
    if (!rows.length) rows.push({ id: 'empty', kind: 'empty', selectable: false, key: '', value: '' })
    this.list.setItems(rows)
  }

  render(app, body) {
    const scr = app.screen
    this.list.draw(scr, body.x, body.y, body.w, body.h, (r, { selected, width }) => {
      if (r.kind === 'empty') return [{ text: '  no variables — press a to add one', style: S.dim }]
      return [
        { text: '  ' + fit(r.key, 28), style: selected ? S.title : S.accent },
        { text: truncate(r.value, width - 30), style: S.base },
      ]
    })
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'a': {
        const key = await promptText(app, {
          title: 'Variable name', label: 'e.g. ANTHROPIC_API_KEY',
          validate: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? null : 'letters, digits and underscore only'),
        })
        if (!key) return true
        const value = await promptText(app, { title: key, label: 'Value' })
        if (value === null) return true
        await this.apply(app, (d) => Settings.setEnv(d, key, value), `${key} set`)
        this.reload()
        return true
      }
    }

    const r = this.list.selected()
    if (!r || r.kind === 'empty') return false

    if (ev.name === 'e') {
      const value = await promptText(app, { title: r.key, label: 'Value', value: r.value })
      if (value === null) return true
      await this.apply(app, (d) => Settings.setEnv(d, r.key, value), `${r.key} updated`)
      this.reload()
      return true
    }
    if (ev.name === 'x') {
      const ok = await confirm(app, { title: 'Delete variable', message: `Remove ${r.key}?`, danger: true, yes: 'Delete' })
      if (ok) {
        await this.apply(app, (d) => Settings.setEnv(d, r.key, null), 'deleted')
        this.reload()
      }
      return true
    }
    return false
  }
}

// ── MCP servers ──────────────────────────────────────────────────────

export class McpEditor extends Editor {
  keys = [['a', 'add'], ['e', 'edit'], ['x', 'delete'], ['esc', 'back']]
  help = [
    'a            add a server',
    'e            edit command or arguments',
    'x            delete it',
    '',
    'User-level MCP servers live in ~/.claude.json, not settings.json.',
    'Servers provided by plugins are managed by the plugin and do not',
    'appear here.',
  ]

  constructor(scope) {
    super(scope)
    this.list = new List([])
  }

  reload() {
    this.mcp = Settings.loadMcp()
    const rows = this.mcp.servers.map((s) => ({ ...s, selectable: true }))
    if (!rows.length) rows.push({ id: 'empty', kind: 'empty', selectable: false })
    this.list.setItems(rows)
  }

  render(app, body) {
    const scr = app.screen
    if (this.mcp?.error) {
      scr.put(body.x + 2, body.y, '⚠ ~/.claude.json is not valid JSON — cl will not write to it', S.err)
      return
    }
    const leftW = Math.max(26, Math.min(40, Math.floor(body.w * 0.38)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    this.list.draw(scr, body.x, body.y, leftW, body.h, (s, { selected }) => {
      if (s.kind === 'empty') return [{ text: '  none — press a to add', style: S.dim }]
      return [{ text: '  ' + s.name, style: selected ? S.title : S.base }]
    })

    const x = body.x + leftW + 2
    const w = body.w - leftW - 3
    const s = this.list.selected()
    if (!s || s.kind === 'empty') {
      wrap('MCP servers extend Claude with external tools. Press a to add one.', w)
        .forEach((l, i) => scr.put(x, body.y + i, l, S.dim))
      return
    }
    let cy = body.y
    scr.put(x, cy, truncate(s.name, w), S.title); cy += 2
    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x, cy, fit(label, 9), S.muted)
      scr.put(x + 9, cy, truncate(String(value), w - 9), style)
      cy++
    }
    field('type', s.type ?? (s.url ? 'http' : 'stdio'))
    field('command', s.command)
    field('url', s.url)
    if (Array.isArray(s.args) && s.args.length) {
      scr.put(x, cy, fit('args', 9), S.muted); cy++
      for (const a of s.args) { scr.put(x + 9, cy, truncate(a, w - 9), S.info); cy++ }
    }
    if (s.env && Object.keys(s.env).length) {
      cy++
      scr.put(x, cy, 'env', S.heading); cy++
      for (const [k, v] of Object.entries(s.env)) {
        scr.put(x, cy, truncate(`  ${k}=${v}`, w), S.muted); cy++
      }
    }
  }

  async onKey(ev, app) {
    if (this.mcp?.error) return false
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'a': {
        const name = await promptText(app, {
          title: 'Server name', label: 'Identifier used in tool names',
          validate: (v) => (v ? (this.mcp.servers.some((s) => s.name === v) ? 'already exists' : null) : 'name required'),
        })
        if (!name) return true
        const command = await promptText(app, { title: name, label: 'Command to run, e.g. npx' })
        if (!command) return true
        const argsRaw = await promptText(app, { title: name, label: 'Arguments, space-separated', placeholder: '(none)' })
        if (argsRaw === null) return true
        const args = argsRaw.split(/\s+/).filter(Boolean)
        try {
          Settings.updateMcp((servers) => { servers[name] = args.length ? { command, args } : { command } })
          this.reload()
          app.toast(`${name} added`)
        } catch (err) { app.error(err.message) }
        return true
      }
    }

    const s = this.list.selected()
    if (!s || s.kind === 'empty') return false

    if (ev.name === 'e') {
      const command = await promptText(app, { title: s.name, label: 'Command', value: s.command ?? '' })
      if (command === null) return true
      const argsRaw = await promptText(app, {
        title: s.name, label: 'Arguments, space-separated',
        value: Array.isArray(s.args) ? s.args.join(' ') : '',
      })
      if (argsRaw === null) return true
      const args = argsRaw.split(/\s+/).filter(Boolean)
      try {
        Settings.updateMcp((servers) => {
          servers[s.name] = { ...servers[s.name], command }
          if (args.length) servers[s.name].args = args
          else delete servers[s.name].args
        })
        this.reload()
        app.toast('updated')
      } catch (err) { app.error(err.message) }
      return true
    }
    if (ev.name === 'x') {
      const ok = await confirm(app, { title: 'Delete server', message: `Remove ${s.name}?`, danger: true, yes: 'Delete' })
      if (!ok) return true
      try {
        Settings.updateMcp((servers) => { delete servers[s.name] })
        this.reload()
        app.toast('deleted', S.warn)
      } catch (err) { app.error(err.message) }
      return true
    }
    return false
  }
}
