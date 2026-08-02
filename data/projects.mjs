// Project directories and disk usage for the Data screen.
//
// Sizes are computed on demand — walking 200MB of transcripts on every frame
// would be wasteful — and cached for the lifetime of the process.

import fs from 'node:fs'
import path from 'node:path'
import { P, CACHE_DIRS, exists, formatBytes } from './paths.mjs'
import { projectDirs, listTranscripts, projectCwd } from './sessions.mjs'

const sizeCache = new Map()

export function dirSize(dir, { refresh = false } = {}) {
  if (!refresh && sizeCache.has(dir)) return sizeCache.get(dir)
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try { total += fs.statSync(full).size } catch { /* vanished mid-walk */ }
      }
    }
  }
  sizeCache.set(dir, total)
  return total
}

export function clearSizeCache() {
  sizeCache.clear()
}

// One entry per project folder, with session counts and whether the working
// directory it refers to still exists on disk.
export function listProjects({ withSizes = true } = {}) {
  const transcripts = listTranscripts()
  const byProject = new Map()
  for (const t of transcripts) {
    if (!byProject.has(t.project)) byProject.set(t.project, [])
    byProject.get(t.project).push(t)
  }

  const out = []
  for (const dir of projectDirs()) {
    const items = byProject.get(dir) || []
    const full = path.join(P.projects, dir)
    // A project with sessions yields its exact cwd from a transcript. With no
    // sessions, all we can do is reverse the lossy folder encoding — flag that
    // so the UI does not present a guess as fact.
    const cwd = projectCwd(dir, null)
    const cwdGuessed = items.length === 0
    const newest = items.length ? Math.max(...items.map((i) => i.mtime)) : 0
    const oldest = items.length ? Math.min(...items.map((i) => i.mtime)) : 0
    out.push({
      id: dir,
      dir: full,
      cwd,
      cwdGuessed,
      cwdExists: cwd && !cwdGuessed ? exists(cwd) : exists(cwd),
      sessions: items.length,
      transcripts: items,
      newest,
      oldest,
      size: withSizes ? dirSize(full) : 0,
    })
  }
  out.sort((a, b) => (b.size - a.size) || (b.newest - a.newest))
  return out
}

export function deleteProject(project) {
  fs.rmSync(project.dir, { recursive: true, force: true })
  sizeCache.delete(project.dir)
}

// Transcripts older than `days`, across every project.
export function findOldTranscripts(days) {
  const cutoff = Date.now() - days * 86400_000
  return listTranscripts().filter((t) => t.mtime < cutoff)
}

export function listCaches() {
  const out = []
  for (const name of CACHE_DIRS) {
    const full = path.join(P.claudeDir, name)
    if (!exists(full)) continue
    out.push({ id: name, name, dir: full, size: dirSize(full) })
  }
  out.sort((a, b) => b.size - a.size)
  return out
}

export function emptyDir(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      fs.rmSync(full, { recursive: true, force: true })
      n++
    } catch { /* locked by a running session */ }
  }
  sizeCache.delete(dir)
  return n
}

export function totalUsage() {
  const projects = dirSize(P.projects)
  const caches = listCaches().reduce((s, c) => s + c.size, 0)
  return { projects, caches, total: projects + caches, label: formatBytes(projects + caches) }
}
