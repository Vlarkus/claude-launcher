// Permissions — two-pane, because a rule is a pattern whose meaning is worth
// spelling out before you trust it.

import { S } from '../../tui/theme.mjs'
import { List, confirm, promptText, chooseFrom, listMouse } from '../../tui/widgets.mjs'
import { truncate, fit, wrap } from '../../tui/width.mjs'
import * as Settings from '../../data/settings.mjs'
import { tildify, HOME } from '../../data/paths.mjs'
import { Editor } from './base.mjs'

const LIST_STYLE = { allow: S.ok, ask: S.warn, deny: S.err }

export class PermissionsEditor extends Editor {
  keys = [['a', 'add'], ['e', 'edit'], ['x', 'delete'], ['m', 'move'], ['M', 'mode'], ['d', 'dirs'], ['esc', 'back']]
  help = [
    'a            add a rule',
    'e            edit the highlighted rule',
    'x            delete it',
    'm            move it between allow / ask / deny',
    'M            set the default mode for tools with no matching rule',
    'd            edit additional directories the session may access',
    '',
    'A rule is Tool(pattern), e.g. Bash(git *) or Read(~/notes/**).',
    'Bare tool names such as WebSearch match every call to that tool.',
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
    const rules = Settings.listPermissions(this.data)
    const items = []
    for (const list of Settings.PERMISSION_LISTS) {
      const group = rules.filter((r) => r.list === list)
      if (!group.length) continue
      items.push({ id: `h:${list}`, kind: 'header', label: list, selectable: false })
      for (const r of group) items.push({ id: r.id, kind: 'rule', rule: r })
    }
    if (!items.length) {
      items.push({ id: 'empty', kind: 'empty', selectable: false, label: 'no rules — press a to add one' })
    }
    this.list.setItems(items)
  }

  render(app, body) {
    const scr = app.screen
    const leftW = Math.max(32, Math.min(56, Math.floor(body.w * 0.5)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    const mode = this.data?.permissions?.defaultMode ?? 'default'
    const dirs = Settings.additionalDirs(this.data)

    this.list.draw(scr, body.x, body.y, leftW, body.h - 3, (item, { width }) => {
      if (item.kind === 'header') {
        return [{ text: ' ' + item.label.toUpperCase(), style: LIST_STYLE[item.label] ?? S.heading }]
      }
      if (item.kind === 'empty') return [{ text: '  ' + item.label, style: S.dim }]
      return [{ text: '  ' + fit(item.rule.rule, width - 2), style: S.base }]
    })

    let y = body.y + body.h - 2
    scr.hline(body.x, y - 1, leftW, S.border)
    scr.put(body.x + 2, y, `mode ${mode}`, S.muted)
    scr.put(body.x + 2 + 6 + mode.length, y, dirs.length ? `  +${dirs.length} dir(s)` : '', S.dim)

    this.renderDetail(app, body.x + leftW + 2, body.y, body.w - leftW - 3, body.h)
  }

  renderDetail(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item || item.kind !== 'rule') {
      wrap('Permission rules decide which tool calls run without asking. Press a to add one, M to change the default mode.', w)
        .forEach((l, i) => scr.put(x, y + i, l, S.dim))
      return
    }
    const r = item.rule
    let cy = y
    scr.put(x, cy, truncate(r.rule, w), S.title); cy += 2

    const parsed = parseRule(r.rule)
    const field = (label, value, style = S.base) => {
      if (!value) return
      scr.put(x, cy, fit(label, 9), S.muted)
      scr.put(x + 9, cy, truncate(String(value), w - 9), style)
      cy++
    }
    field('list', r.list, LIST_STYLE[r.list])
    field('tool', parsed.tool)
    field('pattern', parsed.pattern ?? '(every call)', parsed.pattern ? S.base : S.dim)
    cy++
    wrap(explain(r.list, parsed), w).forEach((l) => { scr.put(x, cy, l, S.warn); cy++ })

    const dirs = Settings.additionalDirs(this.data)
    if (dirs.length && cy < y + h - dirs.length - 2) {
      cy++
      scr.put(x, cy, 'additional directories', S.heading); cy++
      for (const d of dirs) { scr.put(x, cy, truncate('  ' + tildify(d), w), S.muted); cy++ }
    }
  }

  async onMouse(m, app) {
    const r = listMouse(this.list, m)
    if (r === 'activate') await this.onKey({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false }, app)
    return !!r
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'a': await this.add(app); return true
      case 'M': await this.setMode(app); return true
      case 'd': await this.editDirs(app); return true
    }

    const item = this.list.selected()
    const r = item?.kind === 'rule' ? item.rule : null
    if (!r) return false

    switch (ev.name) {
      case 'e': {
        const rule = await promptText(app, {
          title: `Edit ${r.list} rule`, label: 'Tool(pattern) — or a bare tool name', value: r.rule,
          validate: (v) => (v ? null : 'rule required'),
        })
        if (rule === null) return true
        await this.apply(app, (d) => { d.permissions[r.list][r.index] = rule }, 'rule updated')
        this.rebuild()
        return true
      }
      case 'x': {
        const ok = await confirm(app, {
          title: 'Delete rule', message: `Remove ${r.rule}?`, detail: `from ${r.list}`,
          danger: true, yes: 'Delete',
        })
        if (ok) {
          await this.apply(app, (d) => Settings.removePermission(d, r), 'deleted')
          this.rebuild()
        }
        return true
      }
      case 'm': {
        const target = await chooseFrom(app, {
          title: 'Move to',
          items: Settings.PERMISSION_LISTS.filter((l) => l !== r.list)
            .map((l) => ({ value: l, label: l, hint: listHint(l) })),
        })
        if (!target) return true
        await this.apply(app, (d) => {
          Settings.removePermission(d, r)
          Settings.addPermission(d, target, r.rule)
        }, `moved to ${target}`)
        this.rebuild()
        return true
      }
    }
    return false
  }

  async add(app) {
    const list = await chooseFrom(app, {
      title: 'Add rule to',
      items: Settings.PERMISSION_LISTS.map((l) => ({ value: l, label: l, hint: listHint(l) })),
    })
    if (!list) return
    const rule = await promptText(app, {
      title: `New ${list} rule`,
      label: 'Tool(pattern), e.g. Bash(git *) — or a bare tool name',
      validate: (v) => (v ? null : 'rule required'),
    })
    if (!rule) return
    const ok = await this.apply(app, (d) => Settings.addPermission(d, list, rule),
      'rule added', { preview: true, title: `Add ${list} rule` })
    if (ok) this.rebuild()
  }

  async setMode(app) {
    const mode = await chooseFrom(app, {
      title: 'Default mode',
      current: this.data?.permissions?.defaultMode ?? 'default',
      items: Settings.PERMISSION_MODES.map((m) => ({ value: m, label: m, hint: modeHint(m) })),
    })
    if (!mode) return
    await this.apply(app, (d) => {
      if (!d.permissions) d.permissions = {}
      d.permissions.defaultMode = mode
    }, `mode ${mode}`)
  }

  async editDirs(app) {
    const cur = Settings.additionalDirs(this.data)
    const value = await promptText(app, {
      title: 'Additional directories',
      label: 'Comma-separated paths every session may access',
      value: cur.map(tildify).join(', '),
    })
    if (value === null) return
    const dirs = value.split(',').map((s) => s.trim()).filter(Boolean)
      .map((p) => p.replace(/^~(?=$|[/\\])/, HOME))
    await this.apply(app, (d) => {
      if (!d.permissions) d.permissions = {}
      if (dirs.length) d.permissions.additionalDirectories = dirs
      else delete d.permissions.additionalDirectories
    }, dirs.length ? `${dirs.length} directory(ies)` : 'cleared')
  }
}

function parseRule(rule) {
  const m = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(rule.trim())
  if (!m) return { tool: rule.trim(), pattern: null }
  return { tool: m[1], pattern: m[2] }
}

function explain(list, { tool, pattern }) {
  const verb = list === 'allow' ? 'run without asking'
    : list === 'deny' ? 'be blocked outright'
    : 'prompt you every time'
  if (!pattern) return `Every ${tool} call will ${verb}.`
  return `${tool} calls matching "${pattern}" will ${verb}.`
}

function listHint(l) {
  return l === 'allow' ? 'run without prompting'
    : l === 'deny' ? 'block outright'
    : 'always prompt'
}

function modeHint(m) {
  switch (m) {
    case 'default': return 'prompt for anything not covered by a rule'
    case 'acceptEdits': return 'auto-accept file edits'
    case 'plan': return 'start in plan mode — no changes until you approve'
    case 'bypassPermissions': return 'skip every check — trusted directories only'
    default: return ''
  }
}
