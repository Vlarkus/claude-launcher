// Data — what Claude has left on disk.
//
// Two-pane, because a project has a size, a session count and a working
// directory that may no longer exist. Projects whose directory is gone are the
// main thing worth deleting, so they are called out.

import { S } from '../tui/theme.mjs'
import { List, confirm, chooseFrom, showText } from '../tui/widgets.mjs'
import { truncate, fit, wrap } from '../tui/width.mjs'
import * as Projects from '../data/projects.mjs'
import * as Sessions from '../data/sessions.mjs'
import { tildify, formatBytes, formatAge, exists, shortProject } from '../data/paths.mjs'
import { openFolder } from '../launch.mjs'

export class DataScreen {
  id = 'data'
  title = 'Data'
  keys = [['enter', 'sessions'], ['x', 'delete'], ['X', 'prune'], ['o', 'open'], ['r', 'refresh'], ['?', 'help']]
  help = [
    'enter        list the sessions inside the highlighted project',
    'x            delete the project or cache directory',
    'X            prune transcripts older than a chosen age, everywhere',
    'M            delete every project whose directory no longer exists',
    'o            open the folder in the file manager',
    'r            recompute sizes',
    '',
    'Deleting a project removes its transcripts. It does not touch your code.',
  ]

  constructor() {
    this.list = new List([])
    this.loaded = false
  }

  onEnter() {
    if (!this.loaded) this.reload()
  }

  onReturn() {
    this.loaded = false
  }

  reload() {
    this.loaded = true
    Projects.clearSizeCache()
    this.projects = Projects.listProjects()
    this.caches = Projects.listCaches()
    this.usage = Projects.totalUsage()
    this.rebuild()
  }

  rebuild() {
    const items = []
    if (this.projects.length) {
      items.push({ id: 'h:projects', kind: 'header', label: 'PROJECTS', selectable: false })
      for (const p of this.projects) items.push({ id: p.id, kind: 'project', project: p })
    }
    if (this.caches.length) {
      items.push({ id: 'h:caches', kind: 'header', label: 'CACHES', selectable: false })
      for (const c of this.caches) items.push({ id: 'c:' + c.id, kind: 'cache', cache: c })
    }
    if (!items.length) items.push({ id: 'empty', kind: 'empty', selectable: false })
    this.list.setItems(items)
  }

  headerRight() {
    if (!this.usage) return ''
    const missing = this.projects?.filter((p) => !p.cwdExists).length ?? 0
    return `${formatBytes(this.usage.total)} total${missing ? ` · ${missing} orphaned` : ''}`
  }

  render(app, body) {
    const scr = app.screen
    const leftW = Math.max(36, Math.min(60, Math.floor(body.w * 0.52)))
    scr.vline(body.x + leftW, body.y, body.h, S.border)

    this.list.draw(scr, body.x, body.y, leftW - 1, body.h, (item, { selected, width }) => {
      if (item.kind === 'header') return [{ text: ' ' + item.label, style: S.heading }]
      if (item.kind === 'empty') return [{ text: '  nothing on disk', style: S.dim }]
      if (item.kind === 'cache') {
        const c = item.cache
        return [
          { text: '  ' + fit(c.name + '/', width - 10), style: selected ? S.title : S.muted },
          { text: fit(formatBytes(c.size), 7, 'right'), style: S.dim },
        ]
      }
      const p = item.project
      // Without a session to read the real cwd from, show the folder name
      // rather than a decoded path that may be wrong.
      const name = p.cwdGuessed ? p.id : (shortProject(p.cwd) || p.id)
      return [
        { text: '  ' + (p.cwdExists ? ' ' : '!') + ' ', style: p.cwdExists ? S.base : S.err },
        { text: fit(name, width - 18), style: selected ? S.title : (p.cwdExists ? S.base : S.dim) },
        { text: fit(formatBytes(p.size), 7, 'right'), style: S.muted },
        { text: fit(String(p.sessions), 5, 'right'), style: S.dim },
      ]
    })

    this.renderDetail(app, body.x + leftW + 2, body.y, body.w - leftW - 3, body.h)
  }

  renderDetail(app, x, y, w, h) {
    const scr = app.screen
    const item = this.list.selected()
    if (!item) return
    let cy = y

    if (item.kind === 'cache') {
      const c = item.cache
      scr.put(x, cy, c.name, S.title); cy += 2
      scr.put(x, cy, fit('size', 9), S.muted); scr.put(x + 9, cy, formatBytes(c.size), S.base); cy++
      scr.put(x, cy, fit('path', 9), S.muted); scr.put(x + 9, cy, truncate(tildify(c.dir), w - 9), S.dim); cy += 2
      wrap(cacheDesc(c.name), w).forEach((l) => { scr.put(x, cy, l, S.warn); cy++ })
      return
    }
    if (item.kind !== 'project') return

    const p = item.project
    scr.put(x, cy, truncate(p.cwdGuessed ? p.id : (shortProject(p.cwd) || p.id), w), S.title); cy += 2

    const field = (label, value, style = S.base) => {
      if (value === null || value === undefined || value === '') return
      scr.put(x, cy, fit(label, 9), S.muted)
      scr.put(x + 9, cy, truncate(String(value), w - 9), style)
      cy++
    }
    if (p.cwdGuessed) {
      field('path', 'unknown — no session recorded one', S.dim)
      field('guess', tildify(p.cwd), S.dim)
    } else {
      field('path', tildify(p.cwd), p.cwdExists ? S.base : S.err)
      if (!p.cwdExists) field('', 'directory no longer exists', S.err)
    }
    field('sessions', p.sessions)
    field('size', formatBytes(p.size))
    field('newest', p.newest ? formatAge(p.newest) + ' ago' : null)
    field('oldest', p.oldest ? formatAge(p.oldest) + ' ago' : null)
    field('folder', tildify(p.dir), S.dim)

    if (p.transcripts.length && cy < y + h - 3) {
      cy++
      scr.put(x, cy, 'sessions', S.heading); cy++
      const room = y + h - cy - 1
      for (const t of p.transcripts.slice(0, room)) {
        const meta = Sessions.readSessionMeta(t.file)
        const title = Sessions.displayTitle(meta)
        scr.put(x, cy, truncate('  ' + title, w - 14), S.muted)
        scr.put(x + w - 13, cy, fit(formatAge(t.mtime), 5, 'right'), S.dim)
        scr.put(x + w - 7, cy, fit(formatBytes(t.size), 6, 'right'), S.dim)
        cy++
      }
      if (p.transcripts.length > room) {
        scr.put(x, cy, `  +${p.transcripts.length - room} more`, S.dim)
      }
    }
  }

  async onKey(ev, app) {
    switch (ev.name) {
      case 'up': this.list.move(-1); return true
      case 'down': this.list.move(1); return true
      case 'home': this.list.first(); return true
      case 'end': this.list.last(); return true
      case 'r': this.reload(); app.toast('recomputed'); return true
      case 'X': await this.prune(app); return true
      case 'M': await this.deleteOrphans(app); return true
      case 'escape': app.switchTo('sessions'); return true
    }

    const item = this.list.selected()
    if (!item) return false

    if (ev.name === 'o') {
      const dir = item.kind === 'project'
        ? (item.project.cwdExists ? item.project.cwd : item.project.dir)
        : item.cache.dir
      openFolder(dir)
      app.toast('opened ' + tildify(dir))
      return true
    }

    if (ev.name === 'enter' && item.kind === 'project') {
      await this.browse(app, item.project)
      return true
    }

    if (ev.name === 'x') {
      if (item.kind === 'cache') {
        const c = item.cache
        const ok = await confirm(app, {
          title: 'Empty cache',
          message: `Delete everything in ${c.name}/?`,
          detail: `${formatBytes(c.size)} — Claude will regenerate what it needs.`,
          danger: true, yes: 'Delete',
        })
        if (ok) {
          const n = Projects.emptyDir(c.dir)
          this.reload()
          app.toast(`removed ${n} entries`, S.warn)
        }
        return true
      }
      if (item.kind === 'project') {
        const p = item.project
        const ok = await confirm(app, {
          title: 'Delete project history',
          message: `Delete ${p.sessions} session(s) for ${shortProject(p.cwd) || p.id}?`,
          detail: `${formatBytes(p.size)} of transcripts. Your code is not touched.`,
          danger: true, yes: 'Delete',
        })
        if (ok) {
          Projects.deleteProject(p)
          this.reload()
          app.toast('deleted', S.warn)
        }
        return true
      }
    }
    return false
  }

  async browse(app, project) {
    const items = project.transcripts.map((t) => {
      const meta = Sessions.readSessionMeta(t.file)
      return {
        value: t.file,
        label: Sessions.displayTitle(meta),
        hint: `${formatAge(t.mtime)} · ${formatBytes(t.size)}`,
      }
    })
    if (!items.length) { app.toast('no sessions in this project'); return }
    const choice = await chooseFrom(app, {
      title: `${shortProject(project.cwd) || project.id} — enter to delete a session`,
      items, filterable: true,
    })
    if (!choice) return
    const t = project.transcripts.find((x) => x.file === choice)
    const ok = await confirm(app, {
      title: 'Delete session', message: 'Delete this transcript?',
      detail: `${formatBytes(t.size)}`, danger: true, yes: 'Delete',
    })
    if (ok) {
      Sessions.deleteSession(t)
      this.reload()
      app.toast('deleted', S.warn)
    }
  }

  async prune(app) {
    const days = await chooseFrom(app, {
      title: 'Delete transcripts older than',
      items: [
        { value: 7, label: '7 days' },
        { value: 30, label: '30 days' },
        { value: 90, label: '90 days' },
        { value: 180, label: '180 days' },
        { value: 365, label: '1 year' },
      ],
    })
    if (!days) return
    const old = Projects.findOldTranscripts(days)
    if (!old.length) { app.toast(`nothing older than ${days} days`, S.ok); return }
    const bytes = old.reduce((s, t) => s + t.size, 0)

    await showText(app, {
      title: `${old.length} transcript(s) older than ${days} days`,
      lines: old.slice(0, 200).map((t) => `${formatAge(t.mtime).padStart(5)}  ${formatBytes(t.size).padStart(7)}  ${t.project}`),
    })
    const ok = await confirm(app, {
      title: 'Prune old transcripts',
      message: `Delete ${old.length} transcript(s)?`,
      detail: `Frees ${formatBytes(bytes)}.`,
      danger: true, yes: 'Delete',
    })
    if (!ok) return
    let n = 0
    for (const t of old) { try { Sessions.deleteSession(t); n++ } catch { /* skip locked */ } }
    this.reload()
    app.toast(`pruned ${n} transcript(s)`, S.warn)
  }

  async deleteOrphans(app) {
    const orphans = this.projects.filter((p) => !p.cwdExists)
    if (!orphans.length) { app.toast('no orphaned projects', S.ok); return }
    const bytes = orphans.reduce((s, p) => s + p.size, 0)
    await showText(app, {
      title: `${orphans.length} project(s) whose directory is gone`,
      lines: orphans.map((p) => `${formatBytes(p.size).padStart(7)}  ${String(p.sessions).padStart(3)} sessions  ${tildify(p.cwd)}`),
    })
    const ok = await confirm(app, {
      title: 'Delete orphaned projects',
      message: `Delete history for ${orphans.length} missing directory(ies)?`,
      detail: `Frees ${formatBytes(bytes)}.`,
      danger: true, yes: 'Delete',
    })
    if (!ok) return
    for (const p of orphans) { try { Projects.deleteProject(p) } catch { /* skip locked */ } }
    this.reload()
    app.toast('deleted', S.warn)
  }
}

function cacheDesc(name) {
  switch (name) {
    case 'cache': return 'Claude Code\'s general cache. Safe to empty; it is rebuilt on demand.'
    case 'debug': return 'Debug logs. Safe to empty unless you are chasing a bug.'
    case 'shell-snapshots': return 'Captured shell environments. Regenerated per session.'
    case 'paste-cache': return 'Large pasted content. Safe to empty.'
    case 'file-history': return 'File snapshots used for undo within a session. Emptying loses undo for old sessions.'
    case 'downloads': return 'Files downloaded during sessions.'
    case 'backups': return 'Backups, including the ones cl takes before writing settings.'
    case 'session-env': return 'Per-session environment captures.'
    default: return ''
  }
}
