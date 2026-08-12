// Filesystem reads for the directory picker.
//
// Everything here is cached on the directory's mtime, because the picker
// re-reads on every keystroke and a cold readdir of a large folder is the one
// thing that would make it feel slow. Nothing walks the tree: a directory is
// read only when it is actually shown.

import fs from 'node:fs'
import path from 'node:path'
import { HOME, IS_WINDOWS, exists } from './paths.mjs'
import { listProjects } from './projects.mjs'

const listCache = new Map()

export function normalize(p) {
  if (!p) return ''
  let s = String(p).replace(/\\/g, '/')
  // ~ and ~/x, but not ~foo
  if (s === '~') s = HOME.replace(/\\/g, '/')
  else if (s.startsWith('~/')) s = HOME.replace(/\\/g, '/') + s.slice(1)
  // Collapse repeats, but keep a leading // (UNC).
  const unc = s.startsWith('//')
  s = s.replace(/\/+/g, '/')
  if (unc) s = '/' + s
  // Trailing slash only survives on a root ("C:/", "/").
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export function isRoot(dir) {
  const d = normalize(dir)
  return d === '/' || /^[A-Za-z]:\/?$/.test(d) || d === ''
}

export function parentOf(dir) {
  const d = normalize(dir)
  if (isRoot(d)) return null
  const up = normalize(path.posix.dirname(d))
  // dirname("C:/x") is "C:", which is not a usable path.
  if (/^[A-Za-z]:$/.test(up)) return up + '/'
  return up === d ? null : up
}

export function baseName(dir) {
  const d = normalize(dir)
  if (isRoot(d)) return d
  // Home shows as ~ rather than your username, which is both shorter and the
  // name you actually think of it by.
  if (d === normalize(HOME)) return '~'
  return d.slice(d.lastIndexOf('/') + 1) || d
}

// Subdirectories only — this picker chooses a directory, so files would be
// noise in every column.
export function listDirs(dir, { hidden = false } = {}) {
  const d = normalize(dir)
  if (!d) return []
  let st
  try { st = fs.statSync(d) } catch { return [] }
  if (!st.isDirectory()) return []

  const key = `${d}\u0000${hidden ? 1 : 0}`
  const hit = listCache.get(key)
  if (hit && hit.mtime === st.mtimeMs) return hit.rows

  let entries = []
  try {
    entries = fs.readdirSync(d, { withFileTypes: true })
  } catch {
    // Permission denied, or it vanished between stat and read.
    listCache.set(key, { mtime: st.mtimeMs, rows: [], denied: true })
    return []
  }

  const rows = []
  for (const e of entries) {
    let isDir = e.isDirectory()
    // A junction or symlink reports as a link; resolve it so real folders in
    // OneDrive/Drive mounts are not silently dropped.
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(d, e.name)).isDirectory() } catch { isDir = false }
    }
    if (!isDir) continue
    if (!hidden && e.name.startsWith('.')) continue
    rows.push({ name: e.name, path: normalize(path.join(d, e.name)) })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  listCache.set(key, { mtime: st.mtimeMs, rows })
  return rows
}

export function isDenied(dir, { hidden = false } = {}) {
  return !!listCache.get(`${normalize(dir)}\u0000${hidden ? 1 : 0}`)?.denied
}

// Repo status without spawning git: .git/HEAD is one small read, and it is the
// only thing needed to show the branch.
const gitCache = new Map()

export function gitInfo(dir) {
  const d = normalize(dir)
  const head = path.join(d, '.git', 'HEAD')
  let st = null
  try { st = fs.statSync(head) } catch { /* not a repo, or a worktree file */ }
  if (!st) {
    // A worktree or submodule has .git as a file rather than a directory.
    return { repo: exists(path.join(d, '.git')), branch: null }
  }
  const hit = gitCache.get(head)
  if (hit && hit.mtime === st.mtimeMs) return hit.info
  let branch = null
  try {
    const text = fs.readFileSync(head, 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
    branch = m ? m[1] : text.slice(0, 7) // detached HEAD
  } catch { /* unreadable */ }
  const info = { repo: true, branch }
  gitCache.set(head, { mtime: st.mtimeMs, info })
  return info
}

// Windows has no single filesystem root, so "up" from C:/ is the drive list.
let driveCache = null

export function drives() {
  if (!IS_WINDOWS) return [{ name: '/', path: '/' }]
  if (driveCache) return driveCache
  const out = []
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    if (exists(`${letter}:/`)) out.push({ name: `${letter}:`, path: `${letter}:/` })
  }
  driveCache = out
  return out
}

// Directories cl already knows you work in, newest first. This is the whole
// point of the shortlist: no other picker has this signal.
export function knownDirs() {
  const seen = new Set()
  const out = []
  for (const p of listProjects({ withSizes: false })) {
    if (!p.cwd) continue
    const dir = normalize(p.cwd)
    // A project with no sessions has its cwd reverse-engineered from the
    // folder name, which encodes every separator as "-" and so cannot be
    // undone: ai-meeting-transcriber-tool comes back as .../ai/meeting/tran…
    // Those guesses are wrong far more often than not, and a guess that does
    // not exist on disk is pure noise in a picker — drop it rather than offer
    // a row that cannot be chosen.
    if (p.cwdGuessed && !exists(dir)) continue
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({
      path: dir,
      name: baseName(dir),
      sessions: p.sessions,
      newest: p.newest,
      guessed: p.cwdGuessed,
      exists: exists(dir),
    })
  }
  out.sort((a, b) => (b.newest - a.newest) || (b.sessions - a.sessions))
  return out
}

// mkdir for the picker. Returns the created path; refuses anything that would
// escape the parent or collide.
export function createDir(parent, name) {
  const clean = String(name ?? '').trim()
  if (!clean) throw new Error('a name is required')
  if (/[\\/]/.test(clean)) throw new Error('name cannot contain a path separator')
  if (clean === '.' || clean === '..') throw new Error('not a usable name')
  // Windows rejects these outright; failing here gives a better message than
  // a raw EINVAL from mkdir.
  if (IS_WINDOWS && /[<>:"|?*]/.test(clean)) throw new Error('cannot contain < > : " | ? *')
  const target = normalize(path.join(normalize(parent), clean))
  if (exists(target)) throw new Error('already exists')
  fs.mkdirSync(target, { recursive: false })
  listCache.clear()
  return target
}

export function clearDirCache() {
  listCache.clear()
  gitCache.clear()
  driveCache = null
}
