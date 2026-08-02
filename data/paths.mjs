// Every filesystem location cl touches, resolved for the current platform.
// Nothing else in the codebase builds a path by hand.

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const HOME = os.homedir()
export const PLATFORM = process.platform // 'win32' | 'darwin' | 'linux'
export const IS_WINDOWS = PLATFORM === 'win32'

// Claude honours CLAUDE_CONFIG_DIR; mirror that so cl edits the same files.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, '.claude')

export const LAUNCHER_DIR = path.join(CLAUDE_DIR, 'launcher')

export const P = {
  claudeDir: CLAUDE_DIR,
  settings: path.join(CLAUDE_DIR, 'settings.json'),
  settingsLocal: path.join(CLAUDE_DIR, 'settings.local.json'),
  keybindings: path.join(CLAUDE_DIR, 'keybindings.json'),
  claudeJson: path.join(HOME, '.claude.json'),
  projects: path.join(CLAUDE_DIR, 'projects'),
  sessions: path.join(CLAUDE_DIR, 'sessions'),
  history: path.join(CLAUDE_DIR, 'history.jsonl'),
  sounds: path.join(CLAUDE_DIR, 'sounds'),
  claudeMd: path.join(CLAUDE_DIR, 'CLAUDE.md'),
  plugins: path.join(CLAUDE_DIR, 'plugins'),

  launcher: LAUNCHER_DIR,
  state: path.join(LAUNCHER_DIR, 'state.json'),
  backups: path.join(LAUNCHER_DIR, 'backups'),
  hookShim: path.join(LAUNCHER_DIR, 'hook.mjs'),
  archive: path.join(LAUNCHER_DIR, 'archive'),
}

// Directories whose size is worth showing on the Data screen.
export const CACHE_DIRS = [
  'cache', 'debug', 'shell-snapshots', 'paste-cache',
  'file-history', 'downloads', 'backups', 'session-env',
]

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}

// Claude encodes a working directory into a project folder name by replacing
// every character outside [A-Za-z0-9] with '-'.
//   C:\Users\you            → C--Users-you
//   /home/you/src/app       → -home-you-src-app
export function encodeProject(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// The reverse is lossy — a literal '-' in a folder name is indistinguishable
// from a separator. Sessions carry their real `cwd`, so this is only a
// fallback for project folders with no readable session.
export function decodeProject(name) {
  if (IS_WINDOWS && /^[A-Za-z]--/.test(name)) {
    return name[0] + ':\\' + name.slice(3).replace(/-/g, '\\')
  }
  if (name.startsWith('-')) return '/' + name.slice(1).replace(/-/g, '/')
  return name.replace(/-/g, path.sep)
}

// Shorten a path for display: home becomes '~'.
export function tildify(p) {
  if (!p) return ''
  const norm = p.replace(/\\/g, '/')
  const home = HOME.replace(/\\/g, '/')
  if (norm === home) return '~'
  if (norm.toLowerCase().startsWith(home.toLowerCase() + '/')) {
    return '~/' + norm.slice(home.length + 1)
  }
  return p
}

// Last one or two meaningful segments — what the session list shows as the
// project column.
export function shortProject(p) {
  if (!p) return '?'
  const t = tildify(p)
  if (t === '~') return '~'
  const parts = t.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 1) return t
  const last = parts[parts.length - 1]
  if (last.length >= 12 || parts.length === 2) return last
  return parts.slice(-2).join('/')
}

export function formatBytes(n) {
  if (!n) return '0'
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const s = v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)
  return `${s}${units[i]}`
}

// "3d ago", but "just now" rather than the nonsensical "now ago".
export function formatAgo(ts) {
  if (!ts) return ''
  const age = formatAge(ts)
  return age === 'now' ? 'just now' : `${age} ago`
}

export function formatAge(ts) {
  if (!ts) return ''
  const secs = Math.max(0, (Date.now() - ts) / 1000)
  if (secs < 60) return 'now'
  const mins = secs / 60
  if (mins < 60) return `${Math.floor(mins)}m`
  const hours = mins / 60
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = hours / 24
  if (days < 30) return `${Math.floor(days)}d`
  const months = days / 30
  if (months < 12) return `${Math.floor(months)}mo`
  return `${Math.floor(months / 12)}y`
}
