// Launch — every option that becomes a CLI argument.
//
// No preview pane: each row is an enum or a toggle, so the screen shows the
// whole config at once. The resulting command is rendered at the bottom on
// every keystroke, which is why there is no separate confirmation step — the
// old launcher's confirm screen existed only to show what this line shows
// continuously.
//
// Rows carry an optional horizontal sub-cursor: left/right moves between the
// checkboxes in a flag group, or changes the value of an enum.

import fs from 'node:fs'
import { S } from '../tui/theme.mjs'
import { confirm, promptText, chooseFrom, checkbox } from '../tui/widgets.mjs'
import { truncate, fit, stringWidth, wrap } from '../tui/width.mjs'
import { MODELS, EFFORTS, FLAGS, emptyConfig, displayCommand } from '../launch.mjs'
import * as State from '../data/state.mjs'
import * as Settings from '../data/settings.mjs'
import { tildify, exists, HOME } from '../data/paths.mjs'
import { listAccounts, subscriptionTier } from '../data/accounts.mjs'

// Built fresh each render so a newly logged-in account appears without a
// restart. "this one" is whatever cl itself is running under.
const ACCOUNT_OPTIONS = () => [
  { value: null, label: 'this one', desc: 'Run under the same subscription cl is using.' },
  ...listAccounts().map((a) => ({
    value: a.id,
    label: a.label,
    desc: a.exists
      ? `${a.dir}${subscriptionTier(a) ? ` · ${subscriptionTier(a)}` : ''}`
      : `${a.dir} — not logged in yet: run claude there once and /login`,
  })),
]

const FLAG_GROUPS = [
  { key: 'session', label: 'session' },
  { key: 'safety', label: 'safety' },
  { key: 'debug', label: 'debug' },
]

export class LaunchScreen {
  id = 'launch'
  title = 'Launch'
  keys = [
    ['enter', 'launch'], ['space', 'toggle'], ['h/l', 'change'],
    ['s', 'save profile'], ['L', 'load'], ['r', 'reset'], ['?', 'help'],
  ]
  help = [
    'enter        launch claude with this configuration',
    'space        toggle a flag, or cycle an enum',
    'h / l  ← →   move between flags, or change an enum value',
    'e            edit a text field (same as enter on that row)',
    's            save the current configuration as a profile',
    'L            load a profile',
    'D            delete a profile',
    'r            reset to defaults',
    'p            edit enabled plugins (writes settings.json)',
  ]

  constructor() {
    this.cfg = null
    this.row = 0
    this.cell = 0
    this.offset = 0
    this.profileName = null
  }

  onEnter(app) {
    if (!this.cfg) {
      const last = State.lastLaunch()
      this.cfg = last ? { ...emptyConfig(), ...last, flags: { ...emptyConfig().flags, ...(last.flags || {}) } } : emptyConfig()
      this.cfg.dir = process.cwd()
      this.cfg.resume = null
      if (!State.lastLaunch()) this.cfg.flags.skipPermissions = true
    }
    this.settings = Settings.load('user')
  }

  onReturn() {
    this.settings = Settings.load('user')
  }

  // Rows are rebuilt each frame so counts and summaries stay current.
  rows() {
    const cfg = this.cfg
    const pluginCount = Settings.pluginRows(this.settings?.data || {}).filter((p) => p.enabled).length
    const out = [
      { type: 'enum', key: 'account', label: 'account', options: ACCOUNT_OPTIONS(), value: cfg.account,
        desc: 'Which subscription this session runs under. Sets CLAUDE_CONFIG_DIR on the spawned process, so the two bill separately.' },
      { type: 'enum', key: 'model', label: 'model', options: MODELS, value: cfg.model },
      { type: 'enum', key: 'effort', label: 'effort', options: EFFORTS, value: cfg.effort },
      { type: 'text', key: 'dir', label: 'dir', value: tildify(cfg.dir), desc: 'Working directory the session starts in.' },
      { type: 'text', key: 'prompt', label: 'prompt', value: cfg.prompt, placeholder: '(none)', desc: 'An opening prompt sent as soon as the session starts.' },
      { type: 'text', key: 'name', label: 'name', value: cfg.name, placeholder: '(none)', desc: 'Display name for this session — shows in the Sessions list.' },
      { type: 'text', key: 'agent', label: 'agent', value: cfg.agent, placeholder: '(none)', desc: 'Start the session as a named custom agent.' },
      { type: 'sep' },
      { type: 'action', key: 'plugins', label: 'plugins', value: `${pluginCount} enabled`, hint: 'enter to edit', desc: 'Plugin enablement is a persistent setting, not a per-session flag — editing here writes settings.json.' },
      { type: 'sep' },
    ]
    for (const g of FLAG_GROUPS) {
      out.push({
        type: 'flags', key: g.key, label: g.label,
        flags: FLAGS.filter((f) => f.group === g.key),
      })
    }
    out.push({ type: 'sep' })
    out.push({ type: 'text', key: 'addDirs', label: 'add-dir', value: (cfg.addDirs || []).map(tildify).join(', '), placeholder: '(none)', desc: 'Extra directories the session may read and write.' })
    out.push({ type: 'text', key: 'tools', label: 'tools', value: cfg.tools, placeholder: 'default', desc: 'Restrict the built-in tool set, e.g. "Bash,Edit,Read". Empty string disables all tools.' })
    out.push({ type: 'text', key: 'budget', label: 'budget', value: cfg.budget ? `$${cfg.budget}` : null, placeholder: '(none)', desc: 'Maximum dollars of API spend. Only applies with --print.' })
    return out
  }

  selectableRows(rows) {
    return rows.map((r, i) => ({ r, i })).filter(({ r }) => r.type !== 'sep')
  }

  moveRow(delta) {
    const rows = this.rows()
    const sel = this.selectableRows(rows)
    const pos = sel.findIndex(({ i }) => i === this.row)
    const next = sel[Math.max(0, Math.min(sel.length - 1, (pos < 0 ? 0 : pos) + delta))]
    if (next) { this.row = next.i; this.cell = 0 }
  }

  headerRight() {
    return this.profileName ? `profile: ${this.profileName}` : 'profile: —'
  }

  // Rows here are hand-drawn rather than a List, so the viewport is recorded
  // during render for the mouse to hit-test against.
  async onMouse(m, app) {
    const vp = this.viewport
    if (!vp) return false
    if (m.wheel) {
      this.moveRow(m.wheel === 'up' ? -1 : 1)
      return true
    }
    if (!m.press || m.button !== 0) return false
    if (m.y < vp.y || m.y >= vp.y + vp.h) return false
    const i = this.offset + (m.y - vp.y)
    const rows = this.rows()
    const row = rows[i]
    if (!row || row.type === 'sep') return false

    const again = this.row === i
    this.row = i
    // Clicking directly on a checkbox toggles that flag; clicking elsewhere on
    // a flag row just focuses it.
    if (row.type === 'flags' && vp.cells?.[i]) {
      const cell = vp.cells[i].findIndex((c) => m.x >= c.x && m.x < c.x + c.w)
      if (cell >= 0) {
        this.cell = cell
        this.toggleFlag(app, row.flags[cell])
        return true
      }
    }
    if (again) await this.onKey({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false }, app)
    return true
  }

  render(app, body) {
    const scr = app.screen
    const rows = this.rows()
    const labelW = 9
    const cells = {}

    // Bottom block: description + command preview.
    const cmd = displayCommand(this.cfg)
    const cmdLines = wrap(cmd, body.w - 4).slice(0, 3)
    const bottomH = 2 + 1 + cmdLines.length
    const listH = body.h - bottomH
    const listY = body.y

    // Keep the cursor visible.
    if (this.row < this.offset) this.offset = this.row
    if (this.row >= this.offset + listH) this.offset = this.row - listH + 1
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - listH)))

    for (let vi = 0; vi < listH; vi++) {
      const i = this.offset + vi
      const row = rows[i]
      if (!row) break
      const y = listY + vi
      const selected = i === this.row

      if (row.type === 'sep') continue

      if (selected) scr.fill(body.x, y, body.w, 1, ' ', S.sel)
      scr.put(body.x + 2, y, fit(row.label, labelW), selected ? S.accent : S.muted)
      const vx = body.x + 2 + labelW + 1
      const vw = body.w - (vx - body.x) - 2

      if (row.type === 'enum') {
        let cx = vx
        for (const opt of row.options) {
          const on = opt.value === row.value
          const text = (on ? '▸' : ' ') + opt.label
          if (cx + stringWidth(text) + 1 > vx + vw) break
          cx = scr.put(cx, y, text, on ? S.title : (selected ? S.muted : S.dim))
          cx = scr.put(cx, y, ' ', S.base)
        }
      } else if (row.type === 'flags') {
        let cx = vx
        cells[i] = []
        row.flags.forEach((f, fi) => {
          const on = this.cfg.flags[f.key]
          const focused = selected && fi === this.cell
          const text = `${checkbox(on)}${f.label}`
          if (cx + stringWidth(text) + 2 > vx + vw) return
          const style = focused ? S.selOn : on ? S.title : (selected ? S.muted : S.dim)
          const from = cx
          cx = scr.put(cx, y, text, style)
          cells[i].push({ x: from, w: cx - from })
          cx = scr.put(cx, y, '  ', S.base)
        })
      } else if (row.type === 'action') {
        scr.put(vx, y, truncate(String(row.value ?? ''), vw), selected ? S.title : S.base)
        if (row.hint && selected) {
          const hx = body.x + body.w - 2 - stringWidth(row.hint)
          if (hx > vx) scr.put(hx, y, row.hint, S.dim)
        }
      } else {
        const shown = row.value || row.placeholder || '(none)'
        scr.put(vx, y, truncate(String(shown), vw), row.value ? (selected ? S.title : S.base) : S.dim)
      }
    }

    this.viewport = { y: listY, h: listH, cells }

    // Description of whatever is focused.
    let by = body.y + listH
    scr.hline(body.x, by, body.w, S.border); by++
    const desc = this.currentDescription(rows)
    scr.put(body.x + 2, by, truncate(desc, body.w - 4), S.warn); by++
    for (const line of cmdLines) {
      scr.put(body.x + 2, by, line, S.info); by++
    }
  }

  currentDescription(rows) {
    const row = rows[this.row]
    if (!row) return ''
    if (row.type === 'enum') {
      const opt = row.options.find((o) => o.value === row.value)
      return opt?.desc ?? ''
    }
    if (row.type === 'flags') {
      const f = row.flags[this.cell]
      return f ? f.desc : ''
    }
    return row.desc ?? ''
  }

  async onKey(ev, app) {
    const rows = this.rows()
    const row = rows[this.row]

    switch (ev.name) {
      case 'up': this.moveRow(-1); return true
      case 'down': this.moveRow(1); return true
      case 'home': this.row = 0; this.cell = 0; this.moveRow(0); return true
      case 'end': this.row = rows.length - 1; this.cell = 0; this.moveRow(0); return true
    }

    if (!row) return false

    if (ev.name === 'left' || ev.name === 'right') {
      const dir = ev.name === 'right' ? 1 : -1
      if (row.type === 'enum') {
        const i = row.options.findIndex((o) => o.value === row.value)
        const next = row.options[(i + dir + row.options.length) % row.options.length]
        this.cfg[row.key] = next.value
      } else if (row.type === 'flags') {
        this.cell = Math.max(0, Math.min(row.flags.length - 1, this.cell + dir))
      }
      return true
    }

    if (ev.name === 'space') {
      if (row.type === 'flags') {
        const f = row.flags[this.cell]
        if (f) this.toggleFlag(app, f)
      } else if (row.type === 'enum') {
        const i = row.options.findIndex((o) => o.value === row.value)
        this.cfg[row.key] = row.options[(i + 1) % row.options.length].value
      }
      return true
    }

    if (ev.name === 'enter' || ev.name === 'e') {
      if (row.type === 'text') { await this.editText(app, row); return true }
      if (row.type === 'action' && row.key === 'plugins') { await this.editPlugins(app); return true }
      if (ev.name === 'enter') { await this.doLaunch(app); return true }
      return true
    }

    switch (ev.name) {
      case 'p': await this.editPlugins(app); return true
      case 's': await this.saveProfile(app); return true
      case 'L': await this.loadProfile(app); return true
      case 'D': await this.deleteProfile(app); return true
      case 'r':
        this.cfg = emptyConfig()
        this.cfg.flags.skipPermissions = true
        this.profileName = null
        app.toast('reset')
        return true
      case 'escape':
        app.switchTo('sessions')
        return true
    }
    return false
  }

  toggleFlag(app, f) {
    const flags = this.cfg.flags
    flags[f.key] = !flags[f.key]
    // Keep mutually exclusive combinations honest.
    if (f.key === 'tmux' && flags.tmux && !flags.worktree) {
      flags.worktree = true
      app.toast('--tmux requires --worktree, enabled it too', S.warn)
    }
    if (f.key === 'worktree' && !flags.worktree && flags.tmux) flags.tmux = false
    if (f.key === 'bare' && flags.bare && flags.safeMode) flags.safeMode = false
    if (f.key === 'safeMode' && flags.safeMode && flags.bare) flags.bare = false
  }

  async editText(app, row) {
    if (row.key === 'dir') {
      const { pickDirectory } = await import('../tui/dirpicker.mjs')
      // No `value`: the picker opens where cl was started, every time, rather
      // than wherever the field happens to point.
      const value = await pickDirectory(app, { title: 'Working directory' })
      if (value !== null) this.cfg.dir = value
      return
    }
    if (row.key === 'addDirs') {
      const value = await promptText(app, {
        title: 'Additional directories',
        label: 'Comma-separated paths the session may access',
        value: (this.cfg.addDirs || []).map(tildify).join(', '),
      })
      if (value !== null) {
        this.cfg.addDirs = value.split(',').map((s) => s.trim()).filter(Boolean)
          .map((p) => p.replace(/^~(?=$|[/\\])/, HOME))
      }
      return
    }
    if (row.key === 'budget') {
      const value = await promptText(app, {
        title: 'Max budget (USD)',
        label: 'Leave empty for no limit',
        value: this.cfg.budget ? String(this.cfg.budget) : '',
        validate: (v) => (!v || /^\d+(\.\d+)?$/.test(v) ? null : 'numbers only'),
      })
      if (value !== null) this.cfg.budget = value ? Number(value) : null
      return
    }

    const titles = {
      prompt: ['Opening prompt', 'Sent as soon as the session starts'],
      name: ['Session name', 'Shows in the Sessions list and in sessions/*.json'],
      agent: ['Agent', 'Name of a custom agent to run as'],
      tools: ['Tools', 'e.g. Bash,Edit,Read — or "default"'],
    }
    const [title, label] = titles[row.key] || [row.label, '']
    const value = await promptText(app, { title, label, value: this.cfg[row.key] ?? '' })
    if (value !== null) this.cfg[row.key] = value || null
  }

  async editPlugins(app) {
    for (;;) {
      const data = Settings.load('user')
      if (data.error) { app.error('settings.json is not valid JSON'); return }
      const rows = Settings.pluginRows(data.data)
      const choice = await chooseFrom(app, {
        title: 'Plugins  (space-less: enter toggles, esc closes)',
        items: rows.map((p) => ({
          value: p.id,
          label: `${checkbox(p.enabled)} ${p.name}`,
          hint: p.missing ? 'not installed' : (p.desc || p.marketplace),
        })),
      })
      if (choice === null) return
      const target = rows.find((p) => p.id === choice)
      if (!target) return
      try {
        Settings.update('user', (d) => Settings.setPlugin(d, target.id, !target.enabled))
        this.settings = Settings.load('user')
        app.toast(`${target.name} ${target.enabled ? 'disabled' : 'enabled'} — takes effect next session`)
      } catch (err) {
        app.error(err.message)
        return
      }
    }
  }

  async saveProfile(app) {
    const name = await promptText(app, {
      title: 'Save profile',
      label: 'Name',
      value: this.profileName ?? '',
      validate: (v) => (v ? null : 'name required'),
    })
    if (!name) return
    const { dir, resume, ...rest } = this.cfg
    State.saveProfile(name, rest)
    this.profileName = name
    app.toast(`saved profile "${name}"`)
  }

  async loadProfile(app) {
    const profiles = State.listProfiles()
    if (!profiles.length) { app.toast('no saved profiles — press s to save one', S.warn); return }
    const choice = await chooseFrom(app, {
      title: 'Load profile',
      items: profiles.map((p) => ({ value: p.name, label: p.name, hint: summarize(p) })),
      current: this.profileName,
    })
    if (!choice) return
    const cfg = State.getProfile(choice)
    if (!cfg) return
    this.cfg = { ...emptyConfig(), ...cfg, dir: this.cfg.dir, flags: { ...emptyConfig().flags, ...(cfg.flags || {}) } }
    this.profileName = choice
    app.toast(`loaded "${choice}"`)
  }

  async deleteProfile(app) {
    const profiles = State.listProfiles()
    if (!profiles.length) return
    const choice = await chooseFrom(app, {
      title: 'Delete profile',
      items: profiles.map((p) => ({ value: p.name, label: p.name, hint: summarize(p) })),
    })
    if (!choice) return
    const ok = await confirm(app, { title: 'Delete profile', message: `Delete "${choice}"?`, danger: true, yes: 'Delete' })
    if (ok) {
      State.deleteProfile(choice)
      if (this.profileName === choice) this.profileName = null
      app.toast('deleted', S.warn)
    }
  }

  async doLaunch(app) {
    if (!exists(this.cfg.dir)) { app.error(`${tildify(this.cfg.dir)} does not exist`); return }
    if (this.cfg.flags.worktree) {
      // A worktree needs a git repo; catching this here beats a cryptic failure.
      if (!exists(`${this.cfg.dir}/.git`)) {
        const ok = await confirm(app, {
          title: 'Not a git repository',
          message: `${tildify(this.cfg.dir)} has no .git directory.`,
          detail: '--worktree will fail. Launch anyway?',
        })
        if (!ok) return
      }
    }
    const { dir, resume, ...rest } = this.cfg
    State.rememberLaunch(rest)
    await app.launch(this.cfg)
  }
}

function summarize(p) {
  const bits = []
  if (p.model) bits.push(p.model)
  if (p.effort) bits.push(p.effort)
  const on = Object.entries(p.flags || {}).filter(([, v]) => v).map(([k]) => k)
  if (on.length) bits.push(on.join(' '))
  return bits.join(' · ')
}
