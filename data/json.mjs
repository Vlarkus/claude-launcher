// The only module that writes configuration files.
//
// Contract for every write:
//   1. parse the current file (abort on malformed input rather than clobber)
//   2. apply the change to the parsed object
//   3. serialise with 2-space indent and a trailing newline
//   4. write to <file>.tmp, then rename over the target — atomic
//   5. keep the previous contents in launcher/backups/
//
// JSON.parse preserves insertion order for non-numeric keys, so round-tripping
// settings.json leaves key order alone. Purely numeric keys would be reordered
// by the spec; none of Claude's settings use them.

import fs from 'node:fs'
import path from 'node:path'
import { P, ensureDir, exists } from './paths.mjs'

export class ConfigError extends Error {
  constructor(message, file, cause) {
    super(message)
    this.name = 'ConfigError'
    this.file = file
    this.cause = cause
  }
}

// Strip a UTF-8 BOM — PowerShell's Set-Content leaves one behind and
// JSON.parse rejects it.
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function readText(file) {
  if (!exists(file)) return null
  return stripBom(fs.readFileSync(file, 'utf8'))
}

// Returns { data, raw, exists, error }. Never throws on a bad file — callers
// decide whether a parse failure is fatal, and the raw text stays available so
// the JSON editor can still show it.
export function readJson(file, fallback = {}) {
  const raw = readText(file)
  if (raw === null) return { data: structuredClone(fallback), raw: null, exists: false, error: null }
  if (raw.trim() === '') return { data: structuredClone(fallback), raw, exists: true, error: null }
  try {
    return { data: JSON.parse(raw), raw, exists: true, error: null }
  } catch (err) {
    return { data: null, raw, exists: true, error: err }
  }
}

// Throwing variant for code paths that cannot proceed without valid data.
export function readJsonOrThrow(file, fallback = {}) {
  const r = readJson(file, fallback)
  if (r.error) {
    throw new ConfigError(`${path.basename(file)} is not valid JSON: ${r.error.message}`, file, r.error)
  }
  return r.data
}

export function serialize(data) {
  return JSON.stringify(data, null, 2) + '\n'
}

function timestamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function backupFile(file) {
  if (!exists(file)) return null
  ensureDir(P.backups)
  const base = path.basename(file)
  const stamp = timestamp()
  // Two writes inside the same second would otherwise collide and the older
  // backup would be lost — exactly the one you would want when undoing a
  // rapid sequence of edits.
  let dest = path.join(P.backups, `${base}.${stamp}.bak`)
  for (let n = 1; exists(dest) && n < 1000; n++) {
    dest = path.join(P.backups, `${base}.${stamp}-${n}.bak`)
  }
  fs.copyFileSync(file, dest)
  pruneBackups(base, 20)
  return dest
}

function pruneBackups(base, keep) {
  try {
    const all = fs.readdirSync(P.backups)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak'))
      .sort()
    for (const f of all.slice(0, Math.max(0, all.length - keep))) {
      fs.rmSync(path.join(P.backups, f), { force: true })
    }
  } catch { /* backup pruning is best-effort */ }
}

// Atomic write with a backup of the previous contents.
export function writeJson(file, data, { backup = true } = {}) {
  const text = serialize(data)

  // No-op writes should not churn backups or mtimes.
  const current = readText(file)
  if (current === text) return { changed: false, backup: null }

  if (backup) backupFile(file)
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return { changed: true, backup: null }
}

// Read → mutate → write, with the parse guard in place. `mutate` receives the
// parsed object and may return a replacement or mutate in place.
export function updateJson(file, mutate, { fallback = {}, backup = true } = {}) {
  const r = readJson(file, fallback)
  if (r.error) {
    throw new ConfigError(
      `Refusing to write ${path.basename(file)}: existing file is not valid JSON (${r.error.message})`,
      file, r.error,
    )
  }
  const next = mutate(r.data) ?? r.data
  return writeJson(file, next, { backup })
}

export function listBackups() {
  if (!exists(P.backups)) return []
  return fs.readdirSync(P.backups)
    .filter((f) => f.endsWith('.bak'))
    .map((f) => {
      const full = path.join(P.backups, f)
      const st = fs.statSync(full)
      return { name: f, path: full, size: st.size, mtime: st.mtimeMs, target: f.replace(/\.\d{8}-\d{6}(-\d+)?\.bak$/, '') }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

export function restoreBackup(backupPath, targetFile) {
  const raw = stripBom(fs.readFileSync(backupPath, 'utf8'))
  JSON.parse(raw) // refuse to restore something unparseable
  backupFile(targetFile)
  const tmp = targetFile + '.tmp'
  fs.writeFileSync(tmp, raw, 'utf8')
  fs.renameSync(tmp, targetFile)
}

// Line-oriented diff for the confirmation shown before a settings write.
export function diffLines(before, after) {
  const a = (before ?? '').split('\n')
  const b = (after ?? '').split('\n')
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] }); i++; j++; continue
    }
    // Look ahead for the next resync point.
    const nextInB = b.indexOf(a[i], j)
    const nextInA = a.indexOf(b[j], i)
    if (i < a.length && (nextInB === -1 || (nextInA !== -1 && nextInA - i < nextInB - j))) {
      out.push({ kind: '-', text: a[i] }); i++
    } else if (j < b.length) {
      out.push({ kind: '+', text: b[j] }); j++
    } else {
      out.push({ kind: '-', text: a[i] }); i++
    }
  }
  return out
}
