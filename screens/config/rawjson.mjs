// Raw JSON tree — the escape hatch.
//
// Typed forms cover the settings cl knows about; this covers everything else,
// including keys that do not exist yet. It is a collapsible tree rather than a
// text buffer so the file cannot be left syntactically broken by a stray edit.

import { S } from '../../tui/theme.mjs'
import { List, confirm, promptText, chooseFrom, listMouse } from '../../tui/widgets.mjs'
import { truncate, fit } from '../../tui/width.mjs'
import { readJson, updateJson } from '../../data/json.mjs'
import { tildify } from '../../data/paths.mjs'

export class RawJsonEditor {
  keys = [['enter', 'expand/edit'], ['l/h', 'fold'], ['e', 'edit'], ['a', 'add'], ['x', 'delete'], ['esc', 'back']]
  help = [
    'enter        expand or collapse a branch, or edit a leaf',
    'l / h  → ←   expand / collapse',
    'e            edit the value',
    'a            add a key or array element under the highlighted node',
    'x            delete the node',
    'r            reload from disk',
    '',
    'Values are parsed as JSON when possible, otherwise stored as a string.',
    'Every write is atomic and backed up first.',
  ]

  constructor(file) {
    this.file = file
    this.expanded = new Set([''])
    this.list = new List([])
  }

  reload() {
    const r = readJson(this.file, {})
    this.data = r.data
    this.error = r.error
    this.raw = r.raw
    this.rebuild()
  }

  rebuild() {
    if (this.error) { this.list.setItems([]); return }
    const nodes = []
    const walk = (value, key, pathKey, depth, parentType) => {
      const type = typeOf(value)
      const expandable = type === 'object' || type === 'array'
      const isExpanded = this.expanded.has(pathKey)
      nodes.push({
        id: pathKey || '(root)',
        path: pathKey,
        key,
        value,
        type,
        depth,
        expandable,
        expanded: isExpanded,
        parentType,
        selectable: true,
      })
      if (expandable && isExpanded) {
        const entries = type === 'array'
          ? value.map((v, i) => [String(i), v])
          : Object.entries(value)
        for (const [k, v] of entries) {
          walk(v, k, pathKey ? `${pathKey}.${k}` : k, depth + 1, type)
        }
      }
    }
    const root = this.data ?? {}
    const entries = Object.entries(root)
    for (const [k, v] of entries) walk(v, k, k, 0, 'object')
    if (!entries.length) {
      nodes.push({ id: 'empty', selectable: false, empty: true })
    }
    this.list.setItems(nodes)
  }

  render(app, body) {
    const scr = app.screen
    if (this.error) {
      scr.put(body.x + 2, body.y, '⚠ this file is not valid JSON', S.err)
      scr.put(body.x + 2, body.y + 1, truncate(this.error.message, body.w - 4), S.muted)
      scr.put(body.x + 2, body.y + 3, 'cl will not write to it. Fix it by hand, or restore a backup with B.', S.dim)
      const lines = (this.raw ?? '').split('\n').slice(0, body.h - 6)
      lines.forEach((l, i) => scr.put(body.x + 2, body.y + 5 + i, truncate(l, body.w - 4), S.dim))
      return
    }

    this.list.draw(scr, body.x, body.y, body.w, body.h - 2, (n, { selected, width }) => {
      if (n.empty) return [{ text: '  (empty) — press a to add a key', style: S.dim }]
      const indent = '  '.repeat(n.depth + 1)
      const marker = n.expandable ? (n.expanded ? '▾ ' : '▸ ') : '  '
      const spans = [
        { text: indent + marker, style: S.dim },
        { text: n.key, style: selected ? S.title : S.accent },
      ]
      if (n.expandable) {
        const count = n.type === 'array' ? n.value.length : Object.keys(n.value).length
        spans.push({ text: `  ${n.type === 'array' ? '[' + count + ']' : '{' + count + '}'}`, style: S.dim })
      } else {
        spans.push({ text: '  ', style: S.base })
        spans.push({ text: truncate(render(n.value), Math.max(8, width - indent.length - n.key.length - 8)), style: valueStyle(n.value) })
      }
      return spans
    })

    const y = body.y + body.h - 1
    scr.hline(body.x, y - 1, body.w, S.border)
    scr.put(body.x + 2, y, tildify(this.file), S.muted)
  }

  async onMouse(m, app) {
    const r = listMouse(this.list, m)
    if (r === 'activate') await this.onKey({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false }, app)
    return !!r
  }

  async onKey(ev, app) {
    if (this.error) {
      if (ev.name === 'r') { this.reload(); return true }
      return false
    }

    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'pageup': this.list.page(-1, app.screen.rows - 6); return true
      case 'pagedown': this.list.page(1, app.screen.rows - 6); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'r': this.reload(); app.toast('reloaded'); return true
    }

    const n = this.list.selected()
    if (!n || n.empty) {
      if (ev.name === 'a') { await this.add(app, null); return true }
      return false
    }

    if (ev.name === 'right') {
      if (n.expandable) { this.expanded.add(n.path); this.rebuild() }
      return true
    }
    if (ev.name === 'left') {
      if (n.expandable && n.expanded) { this.expanded.delete(n.path); this.rebuild() }
      return true
    }
    if (ev.name === 'enter' || ev.name === 'space') {
      if (n.expandable) {
        if (n.expanded) this.expanded.delete(n.path)
        else this.expanded.add(n.path)
        this.rebuild()
      } else {
        await this.edit(app, n)
      }
      return true
    }
    if (ev.name === 'e') { await this.edit(app, n); return true }
    if (ev.name === 'a') { await this.add(app, n); return true }
    if (ev.name === 'x') { await this.remove(app, n); return true }
    return false
  }

  async edit(app, n) {
    if (n.expandable) { app.toast('expand it and edit the leaves', S.warn); return }
    const value = await promptText(app, {
      title: n.path,
      label: `current type: ${n.type} — JSON is parsed, anything else is a string`,
      value: typeof n.value === 'string' ? n.value : JSON.stringify(n.value),
    })
    if (value === null) return
    const parsed = parseValue(value)
    await this.write(app, (root) => setPath(root, n.path, parsed), `${n.path} = ${render(parsed)}`)
  }

  async add(app, n) {
    // Add under the highlighted container, or at the root.
    let targetPath = ''
    let targetType = 'object'
    if (n) {
      if (n.expandable) { targetPath = n.path; targetType = n.type }
      else {
        const parts = n.path.split('.')
        parts.pop()
        targetPath = parts.join('.')
        targetType = n.parentType ?? 'object'
      }
    }

    let key
    if (targetType === 'array') {
      const arr = targetPath ? getPath(this.data, targetPath) : null
      key = String(Array.isArray(arr) ? arr.length : 0)
    } else {
      key = await promptText(app, {
        title: targetPath ? `Add under ${targetPath}` : 'Add key at root',
        label: 'Key name',
        validate: (v) => (v ? null : 'key required'),
      })
      if (!key) return
    }

    const raw = await promptText(app, {
      title: targetPath ? `${targetPath}.${key}` : key,
      label: 'Value — JSON is parsed ({} and [] make a container)',
      placeholder: '""',
    })
    if (raw === null) return
    const value = parseValue(raw === '' ? '""' : raw)
    const full = targetPath ? `${targetPath}.${key}` : key

    await this.write(app, (root) => setPath(root, full, value), `${full} added`)
    this.expanded.add(targetPath)
  }

  async remove(app, n) {
    const ok = await confirm(app, {
      title: 'Delete node',
      message: `Remove ${n.path}?`,
      detail: n.expandable ? `and everything under it` : render(n.value),
      danger: true, yes: 'Delete',
    })
    if (!ok) return
    await this.write(app, (root) => deletePath(root, n.path), `${n.path} deleted`)
  }

  async write(app, mutate, message) {
    try {
      updateJson(this.file, (root) => { mutate(root); return root })
      this.reload()
      app.toast(message)
    } catch (err) {
      app.error(err.message)
    }
  }
}

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function render(v) {
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function valueStyle(v) {
  if (typeof v === 'boolean') return v ? S.ok : S.dim
  if (typeof v === 'number') return S.magenta
  if (v === null) return S.dim
  return S.info
}

function parseValue(text) {
  const t = text.trim()
  if (t === '') return ''
  try { return JSON.parse(t) } catch { return text }
}

function getPath(root, path) {
  let cur = root
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(root, path, value) {
  const parts = path.split('.')
  const last = parts.pop()
  let cur = root
  for (const part of parts) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  if (Array.isArray(cur)) cur[Number(last)] = value
  else cur[last] = value
}

function deletePath(root, path) {
  const parts = path.split('.')
  const last = parts.pop()
  let cur = root
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return
    cur = cur[part]
  }
  if (Array.isArray(cur)) cur.splice(Number(last), 1)
  else delete cur[last]
}
