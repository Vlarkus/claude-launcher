#!/usr/bin/env node
// Cross-platform installer.
//
//   node install.mjs           install the shim
//   node install.mjs --check   report without changing anything
//
// Works from wherever the repo is cloned: the shim it writes points back at
// this checkout, resolved from this file rather than assumed. Re-running is
// safe, and it never overwrites a shim that points somewhere else without
// saying so.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(SELF, 'cl.mjs')
const HOME = os.homedir()
const WIN = process.platform === 'win32'
const CHECK = process.argv.includes('--check')

const g = (s) => `\x1b[32m${s}\x1b[0m`
const y = (s) => `\x1b[33m${s}\x1b[0m`
const r = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[90m${s}\x1b[0m`

let problems = 0
const ok = (l, d = '') => console.log(`  ${g('+')} ${l.padEnd(22)} ${d}`)
const warn = (l, d = '') => console.log(`  ${y('!')} ${l.padEnd(22)} ${d}`)
const bad = (l, d = '') => { problems++; console.log(`  ${r('x')} ${l.padEnd(22)} ${d}`) }

console.log(`\n\x1b[1mlazy-claude — install\x1b[0m\n`)

// ── Preconditions ────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0])
if (major >= 18) ok('node', `v${process.versions.node}`)
else bad('node', `v${process.versions.node} — needs 18 or newer`)

if (fs.existsSync(ENTRY)) ok('entry point', ENTRY)
else bad('entry point', `missing: ${ENTRY}`)

// claude itself is optional at install time — cl is still useful for browsing
// history and editing config without it.
const onPath = (name) => {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase())
      if (fs.existsSync(p)) return p
    }
  }
  return null
}
const claude = onPath('claude')
if (claude) ok('claude', claude)
else warn('claude', 'not on PATH — cl runs, but cannot launch sessions')

// ── Shim ─────────────────────────────────────────────────────────────
const binDir = WIN
  ? path.join(HOME, 'bin')
  : (process.env.XDG_BIN_HOME || path.join(HOME, '.local', 'bin'))
const shim = path.join(binDir, WIN ? 'cl.cmd' : 'cl')
const body = WIN
  ? `@echo off\r\nnode "${ENTRY}" %*\r\n`
  : `#!/bin/sh\nexec node ${JSON.stringify(ENTRY)} "$@"\n`

if (CHECK) {
  const existing = fs.existsSync(shim) ? fs.readFileSync(shim, 'utf8') : null
  if (existing === null) warn('shim', `would create ${shim}`)
  else if (existing === body) ok('shim', `up to date: ${shim}`)
  else warn('shim', `would rewrite ${shim}`)
} else {
  fs.mkdirSync(binDir, { recursive: true })
  const existing = fs.existsSync(shim) ? fs.readFileSync(shim, 'utf8') : null
  if (existing && existing !== body && !existing.includes('cl.mjs')) {
    warn('shim', `${shim} exists and does not look like cl — leaving it alone`)
    console.log(dim(`      remove it yourself, or install elsewhere with PATH`))
  } else {
    fs.writeFileSync(shim, body, 'utf8')
    if (!WIN) fs.chmodSync(shim, 0o755)
    ok('shim', shim)
  }
}

// ── PATH ─────────────────────────────────────────────────────────────
const pathDirs = (process.env.PATH || '').split(path.delimiter)
  .map((d) => path.resolve(d.trim()).toLowerCase())
const inPath = pathDirs.includes(path.resolve(binDir).toLowerCase())

if (inPath) {
  ok('PATH', `${binDir} is on PATH`)
} else if (WIN) {
  warn('PATH', `${binDir} is not on PATH`)
  console.log(dim('      add it for this user, then open a NEW terminal:'))
  console.log(dim(`      [Environment]::SetEnvironmentVariable('Path',`))
  console.log(dim(`        [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')`))
} else {
  warn('PATH', `${binDir} is not on PATH`)
  console.log(dim('      add this to ~/.bashrc or ~/.zshrc:'))
  console.log(dim(`      export PATH="${binDir}:$PATH"`))
}

// ── Hook shim paths ──────────────────────────────────────────────────
// Hooks store an absolute path to hook.mjs. Moving or re-cloning the repo
// leaves those pointing at the old location, which fails silently — the hook
// just never fires. Worth reporting rather than discovering later.
const settingsFile = path.join(
  process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude'),
  'settings.json',
)
try {
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')
    const stale = []
    for (const [event, groups] of Object.entries(JSON.parse(raw).hooks ?? {})) {
      for (const grp of groups ?? []) {
        for (const h of grp.hooks ?? []) {
          const m = /hook\.mjs/.test(h.command || '')
          if (m && !h.command.includes(SELF)) stale.push(`${event}: ${h.command.slice(0, 60)}`)
        }
      }
    }
    if (stale.length) {
      warn('hooks', `${stale.length} point at a different checkout`)
      for (const s of stale) console.log(dim(`      ${s}`))
      console.log(dim('      fix in cl: Config → Hooks → edit, or re-add with c'))
    } else {
      ok('hooks', 'none stale')
    }
  }
} catch { warn('hooks', 'could not read settings.json') }

console.log()
if (problems) {
  console.log(`${r(`${problems} problem(s)`)} — cl will not run until these are fixed\n`)
  process.exitCode = 1
} else {
  console.log(`  run: ${g('cl')}      check: ${g('cl doctor')}\n`)
}
