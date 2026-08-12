// Accounts — the subscriptions cl can launch sessions under.
//
// An account is a label and a directory, nothing more. Claude Code keeps the
// whole identity (token, settings, history, MCP) under CLAUDE_CONFIG_DIR, so
// pointing at a different directory is what makes a different subscription.
//
// Removing an account here removes cl's pointer to it. It never touches the
// directory, because that is where the credential lives and deleting it would
// log you out of a paid subscription — a far bigger action than the one the
// key implies.

import fs from 'node:fs'
import path from 'node:path'
import { S, accountStyle } from '../tui/theme.mjs'
import { List, confirm, promptText, listMouse } from '../tui/widgets.mjs'
import { truncate, fit, wrap } from '../tui/width.mjs'
import { tildify, exists } from '../data/paths.mjs'
import * as Accounts from '../data/accounts.mjs'
import { emptyConfig } from '../launch.mjs'

export class AccountsScreen {
  id = 'accounts'
  title = 'Accounts'
  keys = [
    ['a', 'add'], ['e', 'rename'], ['d', 'directory'], ['x', 'remove'],
    ['enter', 'launch with'], ['?', 'help'],
  ]
  help = [
    'a            add an account',
    'e            rename it',
    'd            change its directory',
    'x            remove it from cl',
    'enter        open Launch with this account selected',
    'r            re-read login state from disk',
    '',
    'An account is a label and a directory. Claude Code stores the whole',
    'identity — token, settings, history, MCP — under CLAUDE_CONFIG_DIR, so a',
    'second directory is a second subscription. Both can run at once.',
    '',
    'cl never stores a token. Removing an account removes cl\'s pointer only;',
    'the directory and the credential inside it are left alone, so you are not',
    'logged out of anything.',
    '',
    'Not logged in yet? Run `claude` once with CLAUDE_CONFIG_DIR set to that',
    'directory and use /login.',
  ]

  constructor() {
    this.list = new List([])
    this.loaded = false
  }

  onEnter(app) { this.reload(app) }
  onReturn(app) { this.reload(app) }

  reload(app) {
    this.loaded = true
    this.accounts = Accounts.listAccounts()
    this.active = Accounts.activeAccount(this.accounts)
    const items = this.accounts.map((a) => ({ id: a.id, kind: 'account', account: a }))
    if (!items.length) {
      items.push({ id: 'empty', kind: 'empty', selectable: false })
    }
    this.list.setItems(items)
  }

  headerRight() {
    const n = this.accounts?.length ?? 0
    const ready = this.accounts?.filter((a) => a.exists).length ?? 0
    return `${ready}/${n} logged in`
  }

  // Sessions recorded under an account's own config dir.
  sessionCount(account) {
    try {
      const dir = path.join(account.dir, 'projects')
      let n = 0
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        n += fs.readdirSync(path.join(dir, d.name)).filter((f) => f.endsWith('.jsonl')).length
      }
      return n
    } catch {
      return null
    }
  }

  render(app, body) {
    const scr = app.screen
    const leftW = Math.max(30, Math.min(52, Math.floor(body.w * 0.42)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    this.list.draw(scr, body.x, body.y, leftW - 1, body.h, (item, { width }) => {
      if (item.kind === 'empty') {
        return [{ text: '  no accounts — press a to add one', style: S.dim }]
      }
      const a = item.account
      const here = a.id === this.active?.id
      return [
        { text: here ? ' ▸ ' : '   ', style: S.accent },
        { text: fit(a.label, Math.min(14, Math.floor(width * 0.35))), style: accountStyle(a.id) },
        { text: fit(a.exists ? (Accounts.subscriptionTier(a) || 'ready') : 'not logged in', 14),
          style: a.exists ? S.muted : S.warn },
      ]
    })

    this.detail(app, body.x + leftW + 2, body.y, body.w - leftW - 3, body.h)
  }

  detail(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item || item.kind !== 'account') {
      for (const [i, line] of [
        'No accounts configured.',
        '',
        'Press a to add one. You need a directory per subscription;',
        'cl will offer to create it.',
      ].entries()) scr.put(x, y + i, truncate(line, w), i === 0 ? S.muted : S.dim)
      return
    }
    const a = item.account
    let cy = y

    scr.put(x, cy, truncate(a.label, w), accountStyle(a.id)); cy++
    scr.hline(x, cy, w, S.border); cy += 2

    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x, cy, fit(label, 11), S.muted)
      scr.put(x + 11, cy, truncate(String(value), w - 11), style)
      cy++
    }

    field('directory', tildify(a.dir), exists(a.dir) ? S.base : S.err)
    if (!exists(a.dir)) field('', 'this directory does not exist', S.err)
    field('login', a.exists ? 'signed in' : 'not signed in', a.exists ? S.ok : S.warn)
    field('plan', a.exists ? (Accounts.subscriptionTier(a) || 'unknown') : null)
    const n = this.sessionCount(a)
    field('sessions', n === null ? null : String(n))
    if (a.id === this.active?.id) field('in use', 'cl is reading this account', S.accent)

    cy++
    if (!a.exists) {
      scr.put(x, cy, 'to sign in', S.heading); cy++
      for (const line of wrap(`Run claude once with CLAUDE_CONFIG_DIR set to ${tildify(a.dir)}, then /login. On Windows: cpro`, w)) {
        scr.put(x, cy, line, S.muted); cy++
      }
      cy++
    }
    scr.put(x, cy, 'cl stores only this label and path — never the token.', S.dim)
  }

  async onMouse(m, app) {
    return !!listMouse(this.list, m)
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'r': this.reload(app); app.toast('re-read'); return true
      case 'a': await this.add(app); return true
    }

    const item = this.list.selected()
    if (!item || item.kind !== 'account') return false
    const a = item.account

    if (ev.name === 'enter') {
      const launch = app.screens.find((s) => s.id === 'launch')
      if (launch) {
        launch.cfg = { ...emptyConfig(), ...(launch.cfg || {}), account: a.id }
        app.switchTo('launch')
        app.toast(`launching under ${a.label}`)
      }
      return true
    }
    if (ev.name === 'e') {
      const label = await promptText(app, {
        title: 'Rename account', label: 'Shown in the header and on Launch',
        value: a.label, validate: (v) => (v ? null : 'a name is required'),
      })
      if (label) { this.write(this.accounts.map((x) => (x.id === a.id ? { ...x, label } : x)), app, 'renamed') }
      return true
    }
    if (ev.name === 'd') {
      const { pickDirectory } = await import('../tui/dirpicker.mjs')
      const dir = await pickDirectory(app, { title: `Directory for ${a.label}`, value: exists(a.dir) ? a.dir : null })
      if (dir) this.write(this.accounts.map((x) => (x.id === a.id ? { ...x, dir } : x)), app, 'directory set')
      return true
    }
    if (ev.name === 'x' || ev.name === 'delete') {
      const ok = await confirm(app, {
        title: 'Remove account',
        message: `Remove "${a.label}" from cl?`,
        detail: `${tildify(a.dir)} is left untouched — you stay signed in.`,
        yes: 'Remove',
      })
      if (ok) this.write(this.accounts.filter((x) => x.id !== a.id), app, 'removed')
      return true
    }
    return false
  }

  async add(app) {
    const label = await promptText(app, {
      title: 'New account', label: 'A short name, e.g. Max or Pro',
      validate: (v) => {
        if (!v) return 'a name is required'
        if (this.accounts.some((a) => a.label.toLowerCase() === v.toLowerCase())) return 'already used'
        return null
      },
    })
    if (!label) return

    const { pickDirectory } = await import('../tui/dirpicker.mjs')
    const dir = await pickDirectory(app, { title: `Config directory for ${label}` })
    if (!dir) return
    if (this.accounts.some((a) => a.dir.toLowerCase() === dir.replace(/\\/g, '/').toLowerCase())) {
      app.error('another account already uses that directory')
      return
    }

    // Ids are stable and lowercase because the theme keys its colours off
    // them: an account called Max is red wherever it appears.
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'
    let id = base
    for (let i = 2; this.accounts.some((a) => a.id === id); i++) id = `${base}-${i}`

    this.write([...this.accounts, { id, label, dir }], app, `added ${label}`)
  }

  write(next, app, message) {
    Accounts.saveAccounts(next)
    this.reload(app)
    app.toast(message)
  }
}
