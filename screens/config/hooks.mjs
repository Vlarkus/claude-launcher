// Hooks — two-pane, because a hook has an event, a matcher and a command
// worth reading in full.
//
// Also the one editor that knows about portability: a command that shells out
// to powershell or a platform-specific player only works on the machine it was
// written on. `c` rewrites such a hook to go through the shim instead, which
// behaves identically here and also works on macOS and Linux.

import { spawn } from 'node:child_process'
import { S } from '../../tui/theme.mjs'
import { List, confirm, promptText, chooseFrom, showText, checkbox } from '../../tui/widgets.mjs'
import { truncate, fit, wrap } from '../../tui/width.mjs'
import * as Settings from '../../data/settings.mjs'
import * as State from '../../data/state.mjs'
import { P, IS_WINDOWS } from '../../data/paths.mjs'
import { TONES } from '../../hook.mjs'
import { Editor } from './base.mjs'

const SHIM = P.hookShim

export class HooksEditor extends Editor {
  keys = [
    ['a', 'add'], ['e', 'edit'], ['x', 'delete'], ['c', 'portable'],
    ['t', 'test'], ['p', 'presets'], ['esc', 'back'],
  ]
  help = [
    'a            add a hook to an event',
    'e            edit the command',
    'm            edit the matcher (which tools or notifications it applies to)',
    'T            set or clear a timeout',
    'A            toggle async — do not make Claude wait for this hook',
    'x            delete the hook',
    'c            rewrite as a portable command through the shim',
    'C            convert every convertible hook at once',
    't            run the command now to see whether it works',
    'p            apply a saved preset — replaces every hook at once',
    'S            save the current hooks as a preset',
    '',
    'A hook that calls powershell, afplay or an absolute path only works on',
    'the machine it was written on. The shim resolves per-OS at run time, so',
    'settings.json stays identical everywhere.',
  ]

  constructor(scope) {
    super(scope)
    this.list = new List([])
  }

  reload() {
    super.reload()
    this.rebuild()
  }

  rebuild() {
    const hooks = Settings.listHooks(this.data)
    const byEvent = new Map()
    for (const h of hooks) {
      if (!byEvent.has(h.event)) byEvent.set(h.event, [])
      byEvent.get(h.event).push(h)
    }
    const items = []
    // Known events first, in lifecycle order, then anything unrecognised.
    const order = [...Settings.HOOK_EVENTS.map((e) => e.id)]
    for (const ev of byEvent.keys()) if (!order.includes(ev)) order.push(ev)

    for (const event of order) {
      const list = byEvent.get(event)
      if (!list?.length) continue
      items.push({ id: `h:${event}`, kind: 'header', label: event, selectable: false })
      for (const h of list) items.push({ id: h.id, kind: 'hook', hook: h })
    }
    if (!items.length) {
      items.push({ id: 'empty', kind: 'empty', selectable: false, label: 'no hooks — press a to add one' })
    }
    this.list.setItems(items)
  }

  render(app, body) {
    const scr = app.screen
    const leftW = Math.max(30, Math.min(46, Math.floor(body.w * 0.42)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    this.list.draw(scr, body.x, body.y, leftW, body.h, (item, { selected, width }) => {
      if (item.kind === 'header') return [{ text: ' ' + item.label, style: S.heading }]
      if (item.kind === 'empty') return [{ text: '  ' + item.label, style: S.dim }]
      const h = item.hook
      const port = portability(h.command)
      return [
        { text: '  ' + (port.portable ? '◆ ' : '◇ '), style: port.portable ? S.ok : S.warn },
        { text: fit(summarizeCommand(h.command), width - 6), style: S.base },
      ]
    })

    this.renderDetail(app, body.x + leftW + 2, body.y, body.w - leftW - 3, body.h)
  }

  renderDetail(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item || item.kind !== 'hook') {
      const lines = wrap('Hooks run a shell command when Claude reaches a lifecycle event. Press a to add one.', w - 2)
      lines.forEach((l, i) => scr.put(x, y + i, l, S.dim))
      return
    }
    const hk = item.hook
    let cy = y

    scr.put(x, cy, truncate(hk.event, w), S.title); cy++
    const evDesc = Settings.HOOK_EVENTS.find((e) => e.id === hk.event)?.desc
    if (evDesc) { wrap(evDesc, w).slice(0, 2).forEach((l) => { scr.put(x, cy, l, S.muted); cy++ }) }
    cy++

    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x, cy, fit(label, 9), S.muted)
      scr.put(x + 9, cy, truncate(String(value), w - 9), style)
      cy++
    }
    field('matcher', hk.matcher ?? '(all)', hk.matcher ? S.base : S.dim)
    field('type', hk.type)
    field('timeout', hk.timeout ? `${hk.timeout}s` : null)
    const raw = rawEntry(this.data, hk)
    field('async', raw?.async === true ? 'yes — Claude does not wait' : null, S.ok)

    cy++
    scr.put(x, cy, 'command', S.heading); cy++
    for (const line of wrap(hk.command, w)) {
      if (cy >= y + h - 4) break
      scr.put(x, cy, line, S.info); cy++
    }

    cy++
    const port = portability(hk.command)
    if (cy < y + h - 1) {
      scr.put(x, cy, port.portable ? '◆ portable' : '◇ ' + port.reason, port.portable ? S.ok : S.warn)
      cy++
      if (!port.portable && convertCommand(hk.command) && cy < y + h) {
        scr.put(x, cy, 'press c to make it portable', S.dim)
      }
    }
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'a': await this.add(app); return true
      case 'C': await this.convertAll(app); return true
      case 'p': await this.applyPreset(app); return true
      case 'S': await this.savePreset(app); return true
    }

    const item = this.list.selected()
    const hk = item?.kind === 'hook' ? item.hook : null
    if (!hk) return false

    switch (ev.name) {
      case 'e': {
        const cmd = await promptText(app, {
          title: `${hk.event} command`, label: 'Shell command to run', value: hk.command,
          validate: (v) => (v ? null : 'command required'),
        })
        if (cmd === null) return true
        await this.apply(app, (d) => Settings.updateHook(d, hk, { command: cmd }), 'hook updated')
        this.rebuild()
        return true
      }
      case 'm': {
        const matcher = await promptText(app, {
          title: `${hk.event} matcher`,
          label: matcherHelp(hk.event),
          value: hk.matcher ?? '',
          placeholder: 'empty = all',
        })
        if (matcher === null) return true
        await this.apply(app, (d) => this.setMatcher(d, hk, matcher || null), 'matcher updated')
        this.rebuild()
        return true
      }
      case 'T': {
        const t = await promptText(app, {
          title: 'Timeout', label: 'Seconds before the hook is killed. Empty to clear.',
          value: hk.timeout ? String(hk.timeout) : '',
          validate: (v) => (!v || /^\d+$/.test(v) ? null : 'whole seconds only'),
        })
        if (t === null) return true
        await this.apply(app, (d) => {
          const e = rawEntry(d, hk)
          if (!e) return
          if (t) e.timeout = Number(t)
          else delete e.timeout
        }, t ? `timeout ${t}s` : 'timeout cleared')
        this.rebuild()
        return true
      }
      case 'A': {
        const cur = rawEntry(this.data, hk)?.async === true
        await this.apply(app, (d) => {
          const e = rawEntry(d, hk)
          if (!e) return
          if (cur) delete e.async
          else e.async = true
        }, cur ? 'async off' : 'async on')
        this.rebuild()
        return true
      }
      case 'x': {
        const ok = await confirm(app, {
          title: 'Delete hook',
          message: `Remove this ${hk.event} hook?`,
          detail: truncate(hk.command, 60),
          danger: true, yes: 'Delete',
        })
        if (ok) {
          await this.apply(app, (d) => Settings.removeHook(d, hk), 'deleted')
          this.rebuild()
        }
        return true
      }
      case 'c': {
        const next = convertCommand(hk.command)
        if (!next) { app.toast('cl does not know a portable equivalent for this command', S.warn); return true }
        const ok = await this.apply(app, (d) => Settings.updateHook(d, hk, { command: next }),
          'now portable', { preview: true, title: 'Make hook portable' })
        if (ok) this.rebuild()
        return true
      }
      case 't': {
        await this.test(app, hk)
        return true
      }
    }
    return false
  }

  setMatcher(data, hk, matcher) {
    // Moving a hook between matchers means removing and re-adding it.
    const entry = structuredClone(rawEntry(data, hk) ?? { type: 'command', command: hk.command })
    Settings.removeHook(data, hk)
    if (!data.hooks) data.hooks = {}
    if (!Array.isArray(data.hooks[hk.event])) data.hooks[hk.event] = []
    const key = matcher || undefined
    let group = data.hooks[hk.event].find((g) => (g.matcher ?? undefined) === key)
    if (!group) {
      group = key ? { matcher: key, hooks: [] } : { hooks: [] }
      data.hooks[hk.event].push(group)
    }
    if (!Array.isArray(group.hooks)) group.hooks = []
    group.hooks.push(entry)
  }

  async add(app) {
    const event = await chooseFrom(app, {
      title: 'Event',
      items: Settings.HOOK_EVENTS.map((e) => ({ value: e.id, label: e.id, hint: e.desc })),
    })
    if (!event) return

    const templates = [
      ...Object.keys(TONES).map((t) => ({
        value: `node "${SHIM}" sound ${t}`,
        label: `play the ${t} tone`,
        hint: 'portable',
      })),
      { value: `node "${SHIM}" notify Claude needs you`, label: 'desktop notification', hint: 'portable' },
      { value: '', label: 'custom command…', hint: '' },
    ]
    const picked = await chooseFrom(app, { title: `${event} — what should it do?`, items: templates })
    if (picked === null) return

    let command = picked
    if (!command) {
      command = await promptText(app, {
        title: `${event} command`, label: 'Shell command to run',
        validate: (v) => (v ? null : 'command required'),
      })
      if (!command) return
    }

    let matcher = null
    if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'Notification') {
      matcher = await promptText(app, {
        title: 'Matcher', label: matcherHelp(event), placeholder: 'empty = all',
      })
      if (matcher === null) return
    }

    const ok = await this.apply(app, (d) => Settings.addHook(d, { event, matcher: matcher || null, command }),
      'hook added', { preview: true, title: `Add ${event} hook` })
    if (ok) this.rebuild()
  }

  async convertAll(app) {
    const hooks = Settings.listHooks(this.data)
    const convertible = hooks.map((h) => ({ h, next: convertCommand(h.command) })).filter((x) => x.next)
    if (!convertible.length) { app.toast('nothing to convert — every hook is already portable', S.ok); return }
    const ok = await this.apply(app, (d) => {
      for (const { h, next } of convertible) Settings.updateHook(d, h, { command: next })
    }, `${convertible.length} hook(s) made portable`, { preview: true, title: 'Make all hooks portable' })
    if (ok) this.rebuild()
  }

  // Presets replace the whole hooks section, so they always show a diff.
  async applyPreset(app) {
    const presets = State.listHookPresets()
    if (!presets.length) { app.toast('no presets — press S to save the current hooks as one', S.warn); return }
    const choice = await chooseFrom(app, {
      title: 'Apply hook preset',
      items: presets.map((p) => ({
        value: p.name,
        label: p.name,
        hint: p.count ? `${p.count} hook(s) · ${p.events.join(' ')}` : 'no hooks (silent)',
      })),
    })
    if (!choice) return
    const hooks = State.getHookPreset(choice)
    if (!hooks) return
    const ok = await this.apply(app, (d) => {
      if (hooks && Object.keys(hooks).length) d.hooks = structuredClone(hooks)
      else delete d.hooks
    }, `applied "${choice}"`, { preview: true, title: `Apply preset "${choice}"` })
    if (ok) this.rebuild()
  }

  async savePreset(app) {
    const name = await promptText(app, {
      title: 'Save hook preset', label: 'Name',
      validate: (v) => (v ? null : 'name required'),
    })
    if (!name) return
    State.saveHookPreset(name, this.data.hooks ?? {})
    app.toast(`saved preset "${name}"`)
  }

  async test(app, hk) {
    app.screen.leave()
    app.kb.stop()
    process.stdout.write(`\n  running: ${hk.command}\n\n`)
    const code = await new Promise((resolve) => {
      const child = spawn(hk.command, { shell: true, stdio: 'inherit' })
      child.on('error', () => resolve(-1))
      child.on('exit', (c) => resolve(c ?? 0))
    })
    process.stdout.write(`\n  exit ${code} — press any key\n`)
    app.kb.start()
    await app.kb.next()
    app.screen.enter()
    app.screen.invalidate()
    app.toast(code === 0 ? 'hook ran cleanly' : `hook exited ${code}`, code === 0 ? S.ok : S.err)
  }
}

// The raw settings object for a hook, so edits land on the real entry.
function rawEntry(data, hk) {
  return data?.hooks?.[hk.event]?.[hk.groupIndex]?.hooks?.[hk.hookIndex] ?? null
}

function summarizeCommand(cmd) {
  const m = /sound\s+(\w+)/.exec(cmd)
  if (cmd.includes('hook.mjs') && m) return `sound ${m[1]}`
  if (cmd.includes('hook.mjs') && cmd.includes('notify')) return 'notify'
  const play = /play\.ps1"?\s+-Event\s+(\w+)/.exec(cmd)
  if (play) return `play.ps1 ${play[1]}`
  return cmd.replace(/\s+/g, ' ').trim()
}

// Whether a command will work on a machine other than this one.
export function portability(cmd) {
  if (cmd.includes('hook.mjs')) return { portable: true, reason: '' }
  if (/powershell|pwsh|\.ps1|\.cmd|\.bat/i.test(cmd)) return { portable: false, reason: 'Windows only' }
  if (/\bafplay\b|\bosascript\b/.test(cmd)) return { portable: false, reason: 'macOS only' }
  if (/\bpaplay\b|\baplay\b|\bnotify-send\b/.test(cmd)) return { portable: false, reason: 'Linux only' }
  if (/^[A-Za-z]:[\\/]/.test(cmd) || /"[A-Za-z]:[\\/]/.test(cmd)) return { portable: false, reason: 'absolute Windows path' }
  return { portable: true, reason: '' }
}

// Map a known platform-specific command onto the shim. Returns null when cl
// has no faithful equivalent — better to leave the hook alone than to guess.
export function convertCommand(cmd) {
  const play = /play\.ps1"?\s+-Event\s+(\w+)/.exec(cmd)
  if (play && TONES[play[1]]) return `node "${SHIM}" sound ${play[1]}`

  const afplay = /afplay\s+.*[/\\](\w+)\.(wav|mp3)/.exec(cmd)
  if (afplay && TONES[afplay[1]]) return `node "${SHIM}" sound ${afplay[1]}`

  const notify = /notify-send\s+["']?([^"']+)["']?/.exec(cmd)
  if (notify) return `node "${SHIM}" notify ${notify[1].trim()}`

  return null
}

function matcherHelp(event) {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      return 'Tool name pattern, e.g. Bash or Edit|Write'
    case 'Notification':
      return 'Notification kind, e.g. permission_prompt'
    default:
      return 'Pattern this hook applies to'
  }
}
