// One-time migration from the PowerShell launcher.
//
//   node migrate.mjs [--dry]
//
// Imports what presets.json held, then moves the files the old launcher used
// into archive/ rather than deleting them. Re-running is harmless.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { P, ensureDir, exists, formatBytes } from './data/paths.mjs'
import { readJson } from './data/json.mjs'
import { loadState, saveState } from './data/state.mjs'
import { FLAGS, emptyConfig } from './launch.mjs'

const DRY = process.argv.includes('--dry')

function say(mark, text) {
  process.stdout.write(`  ${mark} ${text}\n`)
}

// Old profile shape: { model: 'Default'|'Opus', effort, plugins: [...], flags: ['--verbose'] }
function convertProfile(old) {
  const cfg = emptyConfig()
  delete cfg.dir
  cfg.model = !old.model || old.model === 'Default' ? null : String(old.model).toLowerCase()
  cfg.effort = old.effort || null
  for (const raw of old.flags || []) {
    const f = FLAGS.find((x) => x.flag === raw)
    if (f) cfg.flags[f.key] = true
  }
  // The old launcher always passed this, and its UI implied it.
  cfg.flags.skipPermissions = true
  return cfg
}

export function main() {
  process.stdout.write('\n\x1b[1mcl — migrate from launcher.ps1\x1b[0m\n\n')
  if (DRY) say('~', 'dry run: nothing will be written\n')

  // After a first run presets.json lives in archive/; check both so a fresh
  // clone can still re-import profiles and hook presets.
  const candidates = [
    path.join(P.launcher, 'presets.json'),
    path.join(P.archive, 'presets.json'),
  ]
  const presetsPath = candidates.find((p) => exists(p)) ?? candidates[0]
  const state = loadState()
  let changed = false

  if (exists(presetsPath)) {
    const r = readJson(presetsPath, {})
    if (r.error) {
      say('\x1b[31mx\x1b[0m', `presets.json is not valid JSON — leaving it alone (${r.error.message})`)
    } else {
      const profiles = r.data.profiles ?? {}
      let n = 0
      for (const [name, old] of Object.entries(profiles)) {
        if (state.profiles[name]) continue
        state.profiles[name] = convertProfile(old)
        n++
      }
      if (n) { say('+', `imported ${n} launch profile(s): ${Object.keys(profiles).join(', ')}`); changed = true }
      else say('=', 'launch profiles already imported')

      const templates = r.data.hookTemplates ?? {}
      let h = 0
      if (!state.hookPresets) state.hookPresets = {}
      for (const [name, hooks] of Object.entries(templates)) {
        if (state.hookPresets[name]) continue
        state.hookPresets[name] = hooks ?? {}
        h++
      }
      if (h) {
        say('+', `imported ${h} hook preset(s):`)
        for (const name of Object.keys(templates)) {
          const events = Object.keys(templates[name] ?? {})
          say(' ', `\x1b[90m${name}${events.length ? ` — ${events.join(', ')}` : ' — silent'}\x1b[0m`)
        }
        changed = true
      } else say('=', 'hook presets already imported')
    }
  } else {
    say('=', 'no presets.json — nothing to import')
  }

  if (changed && !DRY) { saveState(); say('+', `wrote ${path.basename(P.state)}`) }

  // Archive rather than delete: these are the only copies of some of it.
  const archive = path.join(P.launcher, 'archive')
  const toArchive = []
  for (const name of fs.readdirSync(P.launcher)) {
    if (name === 'presets.json') toArchive.push(name)
    else if (/^session-.*\.json$/.test(name)) toArchive.push(name)
    else if (name === 'settings.backup.json') toArchive.push(name)
    else if (/^launcher\.backup-.*\.ps1$/.test(name)) toArchive.push(name)
    else if (name === 'launcher.ps1') toArchive.push(name)
  }

  if (!toArchive.length) {
    say('=', 'nothing left to archive')
  } else {
    let bytes = 0
    for (const name of toArchive) bytes += fs.statSync(path.join(P.launcher, name)).size
    say('+', `archiving ${toArchive.length} file(s), ${formatBytes(bytes)} → archive/`)
    for (const name of toArchive) say(' ', `\x1b[90m${name}\x1b[0m`)
    if (!DRY) {
      ensureDir(archive)
      for (const name of toArchive) {
        fs.renameSync(path.join(P.launcher, name), path.join(archive, name))
      }
    }
  }

  process.stdout.write('\n')
  if (DRY) process.stdout.write('  re-run without --dry to apply\n\n')
  else process.stdout.write('  done — run \x1b[36mcl doctor\x1b[0m to check the install\n\n')
}

// Only when run directly — importing this module must not migrate anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
