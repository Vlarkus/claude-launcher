// cl doctor — verify the installation.
//
// Written to be the first thing you run on a new machine: it checks the shim,
// the runtime, every path cl touches, and whether the config files parse. It
// never writes anything.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { P, HOME, PLATFORM, IS_WINDOWS, exists, tildify, formatBytes } from './data/paths.mjs'

import { readJson } from './data/json.mjs'
import * as Settings from './data/settings.mjs'
import { listLive, listTranscripts } from './data/sessions.mjs'
import { dirSize } from './data/projects.mjs'
import { resolveCommand, resolveExecutable } from './launch.mjs'
import { portability } from './screens/config/hooks.mjs'

const OK = '\x1b[32m✓\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'
const BAD = '\x1b[31m✗\x1b[0m'

let problems = 0
let warnings = 0

function ok(label, detail = '') { print(OK, label, detail) }
function warn(label, detail = '') { warnings++; print(WARN, label, detail) }
function bad(label, detail = '') { problems++; print(BAD, label, detail) }

function print(mark, label, detail) {
  const pad = label.length < 26 ? ' '.repeat(26 - label.length) : ' '
  process.stdout.write(`  ${mark} ${label}${pad}${detail}\n`)
}

function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`)
}

export async function doctor() {
  process.stdout.write('\n\x1b[1mcl doctor\x1b[0m\n')

  section('runtime')
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) ok('node', `v${process.versions.node}`)
  else bad('node', `v${process.versions.node} — cl needs 18 or newer`)
  ok('platform', `${PLATFORM} ${process.arch}`)
  ok('home', tildify(HOME))

  const colour = process.stdout.isTTY
  if (colour) ok('terminal', `${process.stdout.columns}x${process.stdout.rows}`)
  else warn('terminal', 'not a TTY — cl needs an interactive terminal')

  section('claude')
  const resolved = resolveCommand('claude', ['--version'])
  if (!resolved.found) {
    bad('claude on PATH', 'not found — cl cannot launch sessions')
  } else {
    const claude = spawnSync(resolved.cmd, resolved.args, { encoding: 'utf8', shell: false })
    if (claude.status === 0) ok('claude on PATH', claude.stdout.trim())
    else bad('claude', `found at ${tildify(resolveExecutable('claude'))} but --version failed`)
  }

  section('paths')
  ok('checkout', tildify(P.self))
  ok('state', `${tildify(P.launcher)}${process.env.CL_DATA_DIR ? '  (CL_DATA_DIR)' : ''}`)
  if (path.resolve(P.self).toLowerCase() === path.resolve(P.launcher).toLowerCase()) {
    warn('layout', 'code and state share a directory — a pull will collide with your state')
  }
  checkPath('config dir', P.claudeDir, true)
  checkPath('projects', P.projects, false)
  checkPath('sessions', P.sessions, false)
  checkPath('launcher', P.launcher, true)
  checkPath('hook shim', P.hookShim, true)

  section('config files')
  for (const [label, file] of [
    ['settings.json', P.settings],
    ['settings.local.json', P.settingsLocal],
    ['.claude.json', P.claudeJson],
    ['keybindings.json', P.keybindings],
  ]) {
    if (!exists(file)) { ok(label, 'absent (fine)'); continue }
    const r = readJson(file, {})
    if (r.error) bad(label, `invalid JSON — ${r.error.message}`)
    else ok(label, `${Object.keys(r.data).length} keys · ${formatBytes(fs.statSync(file).size)}`)
  }

  section('shim')
  const shimStatus = checkShim()

  section('hooks')
  // Hook commands store an absolute path to hook.mjs. Move or re-clone the
  // checkout and they point at nothing — and a hook that cannot run fails
  // silently, so it is worth saying out loud.
  {
    const u = Settings.load('user')
    if (!u.error) {
      const stale = Settings.listHooks(u.data)
        .filter((h) => /hook\.mjs/.test(h.command) && !h.command.includes(P.self))
      if (stale.length) {
        bad('shim path', `${stale.length} hook(s) point at a different checkout`)
        for (const h of stale) print(' ', '', `\x1b[90m${h.event}: ${h.command.slice(0, 62)}\x1b[0m`)
        print(' ', '', '\x1b[90mfix: Config → Hooks → e, or re-run install\x1b[0m')
      }
    }
  }
  const user = Settings.load('user')
  if (user.error) {
    bad('hooks', 'cannot read settings.json')
  } else {
    const hooks = Settings.listHooks(user.data)
    if (!hooks.length) ok('hooks', 'none configured')
    else {
      const nonPortable = hooks.filter((h) => !portability(h.command).portable)
      ok('hooks', `${hooks.length} configured`)
      if (nonPortable.length) {
        warn('portability', `${nonPortable.length} hook(s) will not work on another OS`)
        for (const h of nonPortable) {
          print(' ', '', `\x1b[90m${h.event}: ${h.command.slice(0, 60)}\x1b[0m`)
        }
        print(' ', '', '\x1b[90mfix: Config → Hooks → C\x1b[0m')
      }
      if (user.data.disableAllHooks === true) warn('hooks', 'disableAllHooks is on — none of them run')
    }
  }

  section('plugins')
  if (!user.error) {
    const rows = Settings.pluginRows(user.data)
    const missing = rows.filter((p) => p.missing)
    ok('installed', `${rows.filter((p) => !p.missing).length}`)
    ok('enabled', `${rows.filter((p) => p.enabled).length}`)
    if (missing.length) warn('missing', missing.map((p) => p.name).join(', ') + ' — enabled but not installed')
  }

  section('data')
  const transcripts = listTranscripts()
  const bytes = transcripts.reduce((s, t) => s + t.size, 0)
  const onDisk = dirSize(P.projects)
  ok('sessions', `${transcripts.length} · ${formatBytes(bytes)}`)
  // The gap is subagent transcripts, which live in per-session subdirectories
  // and are not sessions in their own right.
  ok('projects on disk', `${formatBytes(onDisk)}${onDisk > bytes ? ` (${formatBytes(onDisk - bytes)} subagent transcripts)` : ''}`)
  const live = listLive()
  ok('live sessions', live.length ? live.map((l) => `${l.name ?? l.id.slice(0, 8)} (${l.status})`).join(', ') : 'none')

  const state = readJson(P.state, {})
  if (state.error) bad('launcher state', 'invalid JSON')
  else ok('pins', String((state.data.pins ?? []).length))

  process.stdout.write('\n')
  if (problems) {
    process.stdout.write(`\x1b[31m${problems} problem(s)\x1b[0m`)
    if (warnings) process.stdout.write(`, \x1b[33m${warnings} warning(s)\x1b[0m`)
    process.stdout.write('\n\n')
    return 1
  }
  if (warnings) {
    process.stdout.write(`\x1b[33m${warnings} warning(s)\x1b[0m, nothing broken\n\n`)
    return 0
  }
  process.stdout.write('\x1b[32meverything checks out\x1b[0m\n\n')
  return 0
}

function checkPath(label, p, required) {
  if (exists(p)) ok(label, tildify(p))
  else if (required) bad(label, `missing: ${tildify(p)}`)
  else warn(label, `missing: ${tildify(p)} (created on demand)`)
}

// Can you actually type `cl` and have it run this checkout?
//
// Checking only process.env.PATH is not enough. Git Bash injects ~/bin into its
// own PATH even when Windows does not have it, so doctor run from one shell can
// pass while `cl` is unresolvable in the shell you actually use. This checks the
// persisted Windows user PATH as well, and the PowerShell profile function that
// resolves `cl` independently of PATH.
function checkShim() {
  // PATH commonly lists the same directory twice; dedupe so a repeated entry
  // is not reported as a competing installation.
  const seen = new Set()
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .filter((d) => {
      const key = path.resolve(d).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const names = IS_WINDOWS ? ['cl.cmd', 'cl.bat', 'cl.exe'] : ['cl']

  const found = []
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n)
      if (exists(full)) found.push(full)
    }
  }

  // Shims that exist but may not be reachable by name.
  const candidates = [
    path.join(HOME, 'bin'),
    path.join(HOME, '.local', 'bin'),
  ]
  const onDisk = []
  for (const d of candidates) {
    for (const n of names) {
      const full = path.join(d, n)
      if (exists(full) && !onDisk.includes(full)) onDisk.push(full)
    }
  }

  // Deferred so severity can account for the persisted PATH and the profile
  // function — a stale shell is not the same as a broken install.
  let shimNotOnPath = false
  let reachable = found.length > 0
  if (reachable) {
    ok('cl on PATH', tildify(found[0]))
    if (found.length > 1) {
      warn('duplicates', `${found.length} shims on PATH — the first one wins`)
      for (const f of found.slice(1)) print(' ', '', `\x1b[90m${tildify(f)}\x1b[0m`)
    }
    try {
      const text = fs.readFileSync(found[0], 'utf8')
      if (text.includes('cl.mjs')) ok('shim target', 'points at cl.mjs')
      else warn('shim target', 'does not mention cl.mjs — it may be the old PowerShell launcher')
    } catch { /* binary shim, nothing to read */ }
  } else if (onDisk.length) {
    shimNotOnPath = true
  } else {
    warn('cl shim', `not found — run ${IS_WINDOWS ? 'install.ps1' : './install.sh'}`)
  }

  let persisted = false
  if (IS_WINDOWS) {
    // The persisted user PATH is what a fresh terminal gets — process.env.PATH
    // may have been extended by whatever shell doctor is running under. Git
    // Bash injects ~/bin, which is how this check passed while `cl` was
    // unresolvable in PowerShell.
    const userPath = readWindowsUserPath()
    if (userPath !== null) {
      const dirsOnUserPath = userPath.split(';').map((d) => d.trim().replace(/\\+$/, '').toLowerCase())
      const shimDirs = onDisk.map((f) => path.dirname(f).replace(/\\+$/, '').toLowerCase())
      const missing = shimDirs.filter((d) => !dirsOnUserPath.includes(d))
      if (missing.length) {
        warn('windows user PATH', `${missing.join(', ')} not persisted — new terminals will not find cl.cmd`)
      } else if (shimDirs.length) {
        persisted = true
        ok('windows user PATH', 'shim directory is persisted')
      }
    }

    // The profile function makes `cl` work regardless of PATH.
    const profile = path.join(HOME, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    const profile7 = path.join(HOME, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    let fnFound = false
    for (const p of [profile, profile7]) {
      if (!exists(p)) continue
      const text = fs.readFileSync(p, 'utf8')
      if (/function\s+cl\b/i.test(text)) {
        fnFound = true
        if (text.includes('cl.mjs')) ok('powershell function', `cl defined in ${path.basename(path.dirname(p))} profile`)
        else bad('powershell function', 'cl function points at the OLD launcher — it shadows the new one')
      }
    }
    if (!fnFound && !reachable) {
      bad('powershell', 'no cl function and cl.cmd is not on PATH — typing cl will not work')
    }
    reachable = reachable || fnFound
  }

  if (shimNotOnPath) {
    const stale = persisted || reachable
    const detail = stale
      ? 'not on this shell\'s PATH — it is persisted, so open a new terminal'
      : 'shim exists but its directory is not on PATH'
    ;(stale ? warn : bad)('cl.cmd', detail)
    for (const f of onDisk) print(' ', '', `\x1b[90m${tildify(f)}\x1b[0m`)
  }

  return reachable
}

function readWindowsUserPath() {
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' })
    if (r.status !== 0) return null
    const m = /Path\s+REG(_EXPAND)?_SZ\s+(.*)/i.exec(r.stdout)
    return m ? m[2].trim() : null
  } catch { return null }
}
