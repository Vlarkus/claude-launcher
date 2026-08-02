// Statusline, keybindings and memory.
//
// Statusline has a shape cl knows ({ type, command }), so it gets a typed form
// with a test action. Keybindings does not — rather than invent a schema and
// risk writing something Claude will not accept, it opens the raw tree on
// keybindings.json. Memory is read-only here: editing prose belongs in a text
// editor, so cl hands off to $EDITOR.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { S } from '../../tui/theme.mjs'
import { List, promptText, showText, confirm } from '../../tui/widgets.mjs'
import { truncate, fit, wrap } from '../../tui/width.mjs'
import { P, tildify, exists, formatBytes, IS_WINDOWS } from '../../data/paths.mjs'
import { readText } from '../../data/json.mjs'
import { spawnInteractive } from '../../launch.mjs'
import { Editor } from './base.mjs'
import { RawJsonEditor } from './rawjson.mjs'

// ── Statusline ───────────────────────────────────────────────────────

export class StatuslineEditor extends Editor {
  keys = [['e', 'edit command'], ['t', 'test'], ['x', 'remove'], ['esc', 'back']]
  help = [
    'e            edit the command that renders the status line',
    't            run it now and show the output',
    'x            remove the statusline setting entirely',
    '',
    'The command receives session JSON on stdin and prints one line.',
  ]

  reload() {
    super.reload()
  }

  get statusLine() {
    return this.data?.statusLine ?? null
  }

  render(app, body) {
    const scr = app.screen
    const sl = this.statusLine
    let cy = body.y

    if (!sl) {
      wrap('No statusline configured. Press e to set one — a command that reads session JSON on stdin and prints a single line.', body.w - 4)
        .forEach((l) => { scr.put(body.x + 2, cy, l, S.dim); cy++ })
      return
    }

    const field = (label, value, style = S.base) => {
      if (!value) return
      scr.put(body.x + 2, cy, fit(label, 10), S.muted)
      scr.put(body.x + 12, cy, truncate(String(value), body.w - 14), style)
      cy++
    }
    field('type', sl.type ?? 'command')
    field('command', sl.command, S.info)
    if (sl.padding !== undefined) field('padding', String(sl.padding))
    cy++

    // Resolve ~ so it is obvious whether the script actually exists.
    const script = scriptPath(sl.command)
    if (script) {
      const ok = exists(script)
      scr.put(body.x + 2, cy, ok ? '◆ script found' : '◇ script not found', ok ? S.ok : S.err)
      cy++
      scr.put(body.x + 2, cy, truncate(script, body.w - 4), S.dim)
      cy++
    }

    if (this.output) {
      cy++
      scr.put(body.x + 2, cy, 'output', S.heading); cy++
      for (const line of wrap(this.output, body.w - 4).slice(0, 4)) {
        scr.put(body.x + 2, cy, line, S.base); cy++
      }
    }
  }

  async onKey(ev, app) {
    if (ev.name === 'e') {
      const sl = this.statusLine
      const command = await promptText(app, {
        title: 'Statusline command',
        label: 'Runs per render; session JSON arrives on stdin',
        value: sl?.command ?? '',
      })
      if (command === null) return true
      await this.apply(app, (d) => {
        if (!command) { delete d.statusLine; return }
        d.statusLine = { ...(d.statusLine ?? {}), type: 'command', command }
      }, command ? 'statusline set' : 'statusline removed')
      return true
    }
    if (ev.name === 't') {
      const sl = this.statusLine
      if (!sl?.command) { app.toast('nothing to test', S.warn); return true }
      this.output = await runCapture(sl.command)
      app.toast('ran statusline command')
      return true
    }
    if (ev.name === 'x') {
      if (!this.statusLine) return true
      const ok = await confirm(app, { title: 'Remove statusline', message: 'Delete the statusLine setting?', danger: true, yes: 'Remove' })
      if (ok) await this.apply(app, (d) => { delete d.statusLine }, 'removed')
      return true
    }
    return false
  }
}

function scriptPath(command) {
  if (!command) return null
  const m = /(~[^\s"']*|[A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/.exec(command)
  if (!m) return null
  return m[1].replace(/^~/, process.env.USERPROFILE || process.env.HOME || '~')
}

function runCapture(command) {
  return new Promise((resolve) => {
    let out = ''
    try {
      const child = spawn(command, { shell: true })
      child.stdout?.on('data', (d) => { out += d.toString() })
      child.stderr?.on('data', (d) => { out += d.toString() })
      child.on('error', (err) => resolve(`error: ${err.message}`))
      child.on('exit', (code) => resolve(out.trim() || `(no output, exit ${code})`))
      child.stdin?.end('{}')
      setTimeout(() => { try { child.kill() } catch {} ; resolve(out.trim() || '(timed out)') }, 5000)
    } catch (err) {
      resolve(`error: ${err.message}`)
    }
  })
}

// ── Keybindings ──────────────────────────────────────────────────────
// No typed form: cl does not know the schema well enough to write it safely,
// so this is the raw tree pointed at keybindings.json.

export class KeybindingsEditor extends RawJsonEditor {
  constructor() {
    super(P.keybindings)
  }

  get help() {
    return [
      'Editing ~/.claude/keybindings.json directly.',
      '',
      'enter        expand or collapse, or edit a leaf',
      'a            add a key',
      'x            delete',
      '',
      'cl does not impose a schema here — Claude Code owns the format, and',
      'guessing at it would risk writing something it rejects. Use',
      '/keybindings inside Claude for a guided editor.',
    ]
  }
}

// ── Memory ───────────────────────────────────────────────────────────

export class MemoryEditor {
  keys = [['enter', 'view'], ['o', 'open in editor'], ['esc', 'back']]
  help = [
    'enter        view the file',
    'o            open it in $EDITOR (or Notepad on Windows)',
    '',
    'CLAUDE.md files are loaded as persistent instructions. cl shows them',
    'read-only — prose belongs in a real editor.',
  ]

  constructor() {
    this.list = new List([])
  }

  reload() {
    const files = []
    const add = (file, label) => {
      if (!exists(file)) return
      const st = fs.statSync(file)
      files.push({ id: file, file, label, size: st.size, mtime: st.mtimeMs, selectable: true })
    }
    add(P.claudeMd, 'user CLAUDE.md')
    add(path.join(process.cwd(), 'CLAUDE.md'), 'project CLAUDE.md')

    // Auto-memory lives at projects/<encoded-cwd>/memory/. Scan every project
    // rather than assuming one, so this works on any machine.
    if (exists(P.projects)) {
      for (const proj of fs.readdirSync(P.projects)) {
        const memDir = path.join(P.projects, proj, 'memory')
        if (!exists(memDir)) continue
        let entries
        try { entries = fs.readdirSync(memDir) } catch { continue }
        for (const f of entries) {
          if (f.endsWith('.md')) add(path.join(memDir, f), `${proj}/${f}`)
        }
      }
    }
    if (!files.length) files.push({ id: 'empty', selectable: false, empty: true })
    this.list.setItems(files)
  }

  render(app, body) {
    const scr = app.screen
    this.list.draw(scr, body.x, body.y, body.w, body.h - 2, (f, { selected, width }) => {
      if (f.empty) return [{ text: '  no CLAUDE.md found', style: S.dim }]
      return [
        { text: '  ' + fit(f.label, 28), style: selected ? S.title : S.base },
        { text: fit(formatBytes(f.size), 7, 'right'), style: S.dim },
        { text: '  ' + truncate(tildify(f.file), width - 40), style: S.muted },
      ]
    })
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
    }
    const f = this.list.selected()
    if (!f || f.empty) return false

    if (ev.name === 'enter') {
      const text = readText(f.file) ?? ''
      await showText(app, { title: f.label, lines: text.split('\n') })
      return true
    }
    if (ev.name === 'o') {
      const editor = process.env.VISUAL || process.env.EDITOR || (IS_WINDOWS ? 'notepad' : 'nano')
      app.screen.leave()
      app.kb.stop()
      await spawnInteractive(editor, [f.file])
      app.kb.start()
      app.screen.enter()
      app.screen.invalidate()
      this.reload()
      return true
    }
    return false
  }
}
