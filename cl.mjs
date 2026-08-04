#!/usr/bin/env node
// cl — a terminal front-end for Claude Code.
//
// Everything before, between and around a session. Claude owns what happens
// during one.
//
//   cl               open the TUI
//   cl -c            continue the most recent session here, no TUI
//   cl -r [term]     Claude's own resume picker
//   cl doctor        check the installation
//   cl hook …        run a portable hook action (see hook.mjs)

// Rename the process before anything else.
//
// The shim runs `exec node …/cl.mjs`, so without this the process really is
// called "node" — which is what tmux's automatic-rename shows in the window
// list, and what `ps` and `pkill` see. Setting it here rewrites argv, so all
// three agree. CL_PROCESS_NAME overrides it.
process.title = process.env.CL_PROCESS_NAME || 'cl'

import { App } from './app.mjs'
import { DispatchScreen } from './screens/dispatch.mjs'
import { SessionsScreen } from './screens/sessions.mjs'
import { LaunchScreen } from './screens/launch.mjs'
import { StatsScreen } from './screens/stats.mjs'
import { ConfigScreen } from './screens/config.mjs'
import { DataScreen } from './screens/data.mjs'
import { emptyConfig, runClaude } from './launch.mjs'
import { pruneStaleLiveFiles } from './data/sessions.mjs'

// Read from package.json so the two can never drift.
const VERSION = await (async () => {
  try {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

const HELP = `
  cl — front-end for Claude Code

  usage
    cl                    open the launcher
    cl -c, --continue     continue the most recent session in this directory
    cl -r, --resume [t]   Claude's resume picker
    cl doctor             check the installation and report problems
    cl hook <action>      run a hook action (see: cl hook list)
    cl -h, --help         this text
    cl -v, --version      version

  in the launcher
    1-6 / [ ] / tab       Dispatch · Sessions · Launch · Stats · Config · Data
    \`                     toggle the usage summary bar
    enter                 resume the highlighted session
    n                     new session
    j k h l gg G          vim navigation
    ?                     keys for the current screen
    q                     quit

  Anything not listed above is passed straight through to claude.
`

async function main() {
  const argv = process.argv.slice(2)
  const first = argv[0]

  if (first === '-h' || first === '--help') {
    process.stdout.write(HELP)
    return
  }
  if (first === '-v' || first === '--version') {
    process.stdout.write(`cl ${VERSION}\n`)
    return
  }
  if (first === 'doctor') {
    const { doctor } = await import('./doctor.mjs')
    process.exitCode = await doctor()
    return
  }
  if (first === 'hook') {
    // Delegate to the shim so `cl hook sound Stop` works for testing.
    const { main: hookMain } = await import('./hook.mjs')
    hookMain(argv.slice(1))
    return
  }

  // Fast paths that skip the TUI entirely.
  if (first === '-c' || first === '--continue' || first === '-r' || first === '--resume') {
    const cfg = emptyConfig()
    cfg.dir = process.cwd()
    cfg.flags.skipPermissions = true
    if (first === '-c' || first === '--continue') {
      cfg.flags.continue = true
      cfg.extraArgs = argv.slice(1)
    } else {
      // `cl -r` opens Claude's picker; `cl -r <term>` seeds it.
      const term = argv[1]
      cfg.resume = term && !term.startsWith('-') ? term : true
      cfg.extraArgs = argv.slice(cfg.resume === true ? 1 : 2)
    }
    const result = await runClaude(cfg)
    process.exitCode = result?.code ?? 0
    return
  }

  if (argv.length && first.startsWith('-')) {
    // Unrecognised flags belong to claude, not to us.
    const result = await runClaude({ dir: process.cwd(), rawArgs: argv })
    process.exitCode = result?.code ?? 0
    return
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cl: needs an interactive terminal. Try `cl --help`.\n')
    process.exitCode = 1
    return
  }

  pruneStaleLiveFiles()

  const app = new App([
    new DispatchScreen(),
    new SessionsScreen(),
    new LaunchScreen(),
    new StatsScreen(),
    new ConfigScreen(),
    new DataScreen(),
  ])

  // Land on Dispatch when something is running, otherwise on Sessions —
  // an empty monitor is a poor first screen.
  app.refreshLive()
  app.switchTo(app.live.length ? 'dispatch' : 'sessions')

  const restore = () => {
    try { app.screen.leave() } catch { /* already gone */ }
    try { app.kb.stop() } catch { /* already stopped */ }
  }
  process.on('exit', restore)
  process.on('SIGINT', () => { restore(); process.exit(130) })
  process.on('SIGTERM', () => { restore(); process.exit(143) })
  process.on('uncaughtException', (err) => {
    restore()
    process.stderr.write(`\ncl crashed: ${err.stack ?? err.message}\n`)
    process.exit(1)
  })

  await app.run()
}

main().catch((err) => {
  process.stderr.write(`cl: ${err.stack ?? err.message}\n`)
  process.exitCode = 1
})
