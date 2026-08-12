// Turning a launch config into a claude invocation, and running it.
//
// Node hands the child our real terminal via stdio:'inherit', so Claude gets a
// TTY and starts interactively. The old PowerShell launcher could not do this —
// `powershell -File` gave the child no TTY and Claude fell back to --print — so
// it wrote a temp .cmd for the parent shell to run after the launcher exited.
// That handoff is gone. CL_LEGACY_HANDOFF=1 restores it if a platform turns out
// to need it.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_WINDOWS, exists } from './data/paths.mjs'

export const MODELS = [
  { value: null, label: 'default', desc: 'Use the model from settings.' },
  { value: 'opus', label: 'opus', desc: 'Most capable. Deep reasoning, complex work.' },
  { value: 'opus[1m]', label: 'opus·1m', desc: 'Opus with the 1M-token context window.' },
  { value: 'sonnet', label: 'sonnet', desc: 'Balanced speed and intelligence.' },
  { value: 'sonnet[1m]', label: 'sonnet·1m', desc: 'Sonnet with the 1M-token context window.' },
  { value: 'haiku', label: 'haiku', desc: 'Fastest and cheapest. Simple tasks.' },
  { value: 'fable', label: 'fable', desc: 'Fable 5.' },
]

export const EFFORTS = [
  { value: null, label: 'default', desc: 'Use the effort level from settings.' },
  { value: 'low', label: 'low', desc: 'Minimal reasoning. Quick, short answers.' },
  { value: 'medium', label: 'medium', desc: 'Balanced. Good for routine tasks.' },
  { value: 'high', label: 'high', desc: 'Thorough. Multi-step planning and testing.' },
  { value: 'xhigh', label: 'xhigh', desc: 'Extended reasoning. Complex architecture.' },
  { value: 'max', label: 'max', desc: 'Maximum depth. Exhaustive analysis.' },
]

// Boolean flags, grouped the way the Launch screen lays them out.
export const FLAGS = [
  { key: 'continue', flag: '--continue', group: 'session', label: 'continue', desc: 'Continue the most recent conversation in this directory.' },
  { key: 'fork', flag: '--fork-session', group: 'session', label: 'fork', desc: 'When resuming, branch into a new session id instead of reusing the original.' },
  { key: 'worktree', flag: '--worktree', group: 'session', label: 'worktree', desc: 'Create a git worktree for this session and work in isolation.' },
  { key: 'tmux', flag: '--tmux', group: 'session', label: 'tmux', desc: 'Create a tmux session for the worktree. Requires worktree.' },
  { key: 'background', flag: '--background', group: 'session', label: 'background', desc: 'Start as a background agent and return immediately.' },

  { key: 'skipPermissions', flag: '--dangerously-skip-permissions', group: 'safety', label: 'skip-permissions', desc: 'Bypass every permission check. Only for trusted directories.' },
  { key: 'bare', flag: '--bare', group: 'safety', label: 'bare', desc: 'Skip hooks, LSP, plugins, auto-memory and CLAUDE.md discovery.' },
  { key: 'safeMode', flag: '--safe-mode', group: 'safety', label: 'safe-mode', desc: 'Disable all customizations. For troubleshooting a broken config.' },

  { key: 'verbose', flag: '--verbose', group: 'debug', label: 'verbose', desc: 'Show full turn-by-turn output.' },
  { key: 'debug', flag: '--debug', group: 'debug', label: 'debug', desc: 'Enable debug logging.' },
  { key: 'chrome', flag: '--chrome', group: 'debug', label: 'chrome', desc: 'Enable the Claude in Chrome integration.' },
  { key: 'ide', flag: '--ide', group: 'debug', label: 'ide', desc: 'Connect to an IDE on startup when exactly one is available.' },
]

export function emptyConfig() {
  const cfg = {
    model: null,
    effort: null,
    account: null,   // account id; null = whatever cl itself is running under
    agent: null,
    name: null,
    dir: process.cwd(),
    addDirs: [],
    tools: null,
    budget: null,
    prompt: null,
    resume: null,      // session id
    flags: {},
  }
  for (const f of FLAGS) cfg.flags[f.key] = false
  return cfg
}

// Build the argv for `claude`.
export function buildArgs(cfg) {
  // rawArgs means "the caller already knows what it wants" — used when cl is
  // invoked with flags it does not recognise and simply forwards them.
  if (cfg.rawArgs) return [...cfg.rawArgs]

  const args = []

  if (cfg.resume) {
    args.push('--resume')
    if (typeof cfg.resume === 'string') args.push(cfg.resume)
  } else if (cfg.flags?.continue) {
    args.push('--continue')
  }

  if (cfg.model) args.push('--model', cfg.model)
  if (cfg.effort) args.push('--effort', cfg.effort)
  if (cfg.agent) args.push('--agent', cfg.agent)
  if (cfg.name) args.push('--name', cfg.name)
  if (cfg.tools) args.push('--tools', cfg.tools)
  if (cfg.budget) args.push('--max-budget-usd', String(cfg.budget))
  for (const d of cfg.addDirs || []) args.push('--add-dir', d)

  for (const f of FLAGS) {
    if (f.key === 'continue') continue // handled above
    if (cfg.flags?.[f.key]) args.push(f.flag)
  }

  for (const a of cfg.extraArgs || []) args.push(a)
  if (cfg.prompt) args.push(cfg.prompt)
  return args
}

// Shell-ish rendering for the always-visible command preview.
export function displayCommand(cfg) {
  const args = buildArgs(cfg).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
  return 'claude ' + args.join(' ')
}

// Find an executable on PATH, honouring PATHEXT on Windows.
//
// Resolving it ourselves avoids spawning through a shell. Passing an args
// array with shell:true concatenates rather than escapes them (Node DEP0190),
// which would break any argument containing a space — an opening prompt, or a
// path like "D:\My Files\...".
export function resolveExecutable(name) {
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase())
      if (exists(full)) return full
      const upper = path.join(dir, name + ext)
      if (exists(upper)) return upper
    }
  }
  return null
}

// Build a [command, args] pair that runs `name` without a shell.
export function resolveCommand(name, args) {
  const file = resolveExecutable(name)
  if (!file) {
    // Not found — let spawn fail with a clear ENOENT rather than guessing.
    return { cmd: name, args, shell: false, found: false }
  }
  const ext = path.extname(file).toLowerCase()
  if (IS_WINDOWS && (ext === '.cmd' || ext === '.bat')) {
    // A batch shim must run under cmd.exe, but the arguments still arrive as
    // separate argv entries, so Node quotes them for us.
    return {
      cmd: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', file, ...args],
      shell: false,
      found: true,
    }
  }
  if (IS_WINDOWS && ext === '.ps1') {
    return { cmd: 'powershell', args: ['-NoProfile', '-File', file, ...args], shell: false, found: true }
  }
  return { cmd: file, args, shell: false, found: true }
}

// The child runs under the chosen subscription by way of CLAUDE_CONFIG_DIR;
// with no account chosen it simply inherits cl's own environment.
function envForConfig(cfg) {
  const acct = cfg?.account ? accountById(cfg.account) : null
  return acct ? envFor(acct) : process.env
}

// Run claude to completion, returning its exit code. `before` and `after` let
// the caller tear the TUI down and bring it back.
export function runClaude(cfg, { onExit } = {}) {
  const args = buildArgs(cfg)
  const cwd = cfg.dir && exists(cfg.dir) ? cfg.dir : process.cwd()
  const resolved = resolveCommand('claude', args)

  if (process.env.CL_LEGACY_HANDOFF === '1') {
    writeLegacyHandoff(cwd, args)
    return Promise.resolve({ code: 0 })
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(resolved.cmd, resolved.args, { cwd, stdio: 'inherit', shell: false })
    } catch (err) {
      resolve({ code: 127, error: err })
      return
    }
    child.on('error', (err) => resolve({ code: 127, error: err }))
    child.on('exit', (code, signal) => {
      if (onExit) onExit(code, signal)
      resolve({ code: code ?? 0, signal })
    })
  })
}

// Fallback path: hand the command to the parent shell the way the old
// PowerShell launcher did. Only used when CL_LEGACY_HANDOFF=1.
function writeLegacyHandoff(cwd, args) {
  const tmp = os.tmpdir()
  const quoted = args.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
  fs.writeFileSync(path.join(tmp, 'cl-launch.json'), JSON.stringify({ dir: cwd, args }, null, 2), 'utf8')
  if (IS_WINDOWS) {
    fs.writeFileSync(
      path.join(tmp, 'cl-launch.cmd'),
      ['@echo off', `cd /d "${cwd}"`, `claude ${quoted}`].join('\r\n'),
      'ascii',
    )
  } else {
    const sh = path.join(tmp, 'cl-launch.sh')
    fs.writeFileSync(sh, `#!/bin/sh\ncd ${JSON.stringify(cwd)}\nexec claude ${quoted}\n`, 'utf8')
    fs.chmodSync(sh, 0o755)
  }
}

// Open a folder in the platform file manager — used by the Data screen.
export function openFolder(dir) {
  const name = IS_WINDOWS ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(name, [dir], { detached: true, stdio: 'ignore', shell: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}

// Run an external program interactively, with the TUI torn down around it.
export function spawnInteractive(name, args, { cwd } = {}) {
  const resolved = resolveCommand(name, args)
  return new Promise((resolve) => {
    try {
      const child = spawn(resolved.cmd, resolved.args, { cwd, stdio: 'inherit', shell: false })
      child.on('error', () => resolve(-1))
      child.on('exit', (code) => resolve(code ?? 0))
    } catch { resolve(-1) }
  })
}
