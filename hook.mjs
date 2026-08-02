#!/usr/bin/env node
// Portable hook shim.
//
// settings.json holds one command that works on every machine:
//
//   node ~/.claude/launcher/hook.mjs sound Stop
//
// and the OS branching lives here rather than in the settings file. That keeps
// settings.json byte-identical across Windows, macOS and Linux, so it syncs
// with no transformation and Claude's own /config never fights cl over it.
//
// Usage:
//   hook.mjs sound <Event>     play the tone for a lifecycle event
//   hook.mjs notify <text>     best-effort desktop notification
//   hook.mjs list              print the actions this shim understands
//
// Hooks receive JSON on stdin. We drain it so Claude is never left writing to
// a blocked pipe, but nothing here needs to read it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PLATFORM = process.platform

// Note → frequency, and the tone sequences. These reproduce the chords the
// PowerShell play.ps1 generated, so converting a hook does not change how it
// sounds on Windows.
const NOTES = {
  C3: 131, D3: 147, E3: 165, F3: 175, G3: 196, A3: 220, B3: 247,
  C4: 262, D4: 294, E4: 330, F4: 349, G4: 392, A4: 440, B4: 494,
  C5: 523, D5: 587, E5: 659, F5: 698, G5: 784, A5: 880, B5: 988,
  C6: 1047, D6: 1175, E6: 1319,
}

export const TONES = {
  SessionStart: [['C4', 120], ['E4', 120], ['G4', 120], ['C5', 150]],
  Stop: [['C5', 120], ['E5', 120], ['G5', 150]],
  PermissionRequest: [['A4', 80], ['A4', 80], ['A4', 150]],
  PreCompact: [['G4', 150], ['E4', 200]],
  SubagentStop: [['E5', 100], ['C5', 140]],
  SessionEnd: [['G4', 120], ['C4', 200]],
  Error: [['A3', 150], ['F3', 250]],
}

const RATE = 44100

// 16-bit mono PCM WAV with a short fade on each note so the tones do not click.
function synthesize(sequence) {
  let total = 0
  for (const [, ms] of sequence) total += Math.floor((RATE * ms) / 1000)

  const data = Buffer.alloc(total * 2)
  let off = 0
  for (const [note, ms] of sequence) {
    const freq = typeof note === 'number' ? note : NOTES[note]
    if (!freq) continue
    const samples = Math.floor((RATE * ms) / 1000)
    const fade = Math.min(Math.floor(samples / 8), Math.floor(RATE * 0.005))
    for (let i = 0; i < samples; i++) {
      let amp = 1
      if (i < fade) amp = i / fade
      else if (i > samples - fade) amp = (samples - i) / fade
      const v = Math.round(32767 * 0.6 * amp * Math.sin((2 * Math.PI * freq * i) / RATE))
      data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), off)
      off += 2
    }
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)     // PCM chunk size
  header.writeUInt16LE(1, 20)      // format: PCM
  header.writeUInt16LE(1, 22)      // channels: mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32)      // block align
  header.writeUInt16LE(16, 34)     // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function run(cmd, args, { detached = true } = {}) {
  try {
    const child = spawn(cmd, args, {
      detached,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    if (detached) child.unref()
    return true
  } catch {
    return false
  }
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
  }
  return null
}

function playWav(file) {
  if (PLATFORM === 'win32') {
    return run('powershell', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
    ])
  }
  if (PLATFORM === 'darwin') return run('afplay', [file])
  for (const player of ['paplay', 'aplay', 'pw-play']) {
    if (which(player)) return run(player, [file])
  }
  if (which('ffplay')) return run('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file])
  return false
}

function tmpFile(name) {
  const dir = path.join(os.tmpdir(), 'cl-hook')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

export function playSound(event) {
  const seq = TONES[event]
  if (!seq) return false
  const file = tmpFile(`${event}.wav`)
  try {
    // Cache the rendered tone — regenerating on every hook is wasted work.
    if (!fs.existsSync(file)) fs.writeFileSync(file, synthesize(seq))
  } catch {
    return false
  }
  return playWav(file)
}

export function notify(text, title = 'Claude Code') {
  if (PLATFORM === 'darwin') {
    const esc = (s) => s.replace(/"/g, '\\"')
    return run('osascript', ['-e', `display notification "${esc(text)}" with title "${esc(title)}"`])
  }
  if (PLATFORM === 'linux') {
    if (which('notify-send')) return run('notify-send', [title, text])
    return false
  }
  // Windows toast via the WinRT notification API.
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n=$t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode(${JSON.stringify(title)}))>$null
$n.Item(1).AppendChild($t.CreateTextNode(${JSON.stringify(text)}))>$null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show([Windows.UI.Notifications.ToastNotification]::new($t))
`.trim()
  return run('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps])
}

// Actions the hooks editor offers when adding a hook.
export const ACTIONS = [
  ...Object.keys(TONES).map((e) => ({
    id: `sound ${e}`,
    label: `sound ${e}`,
    desc: `Play the ${e} tone.`,
  })),
  { id: 'notify', label: 'notify <text>', desc: 'Best-effort desktop notification.' },
]

export function main(argv = process.argv.slice(2)) {
  // Drain stdin so Claude never blocks writing the hook payload.
  if (!process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.on('data', () => {})
    process.stdin.on('error', () => {})
  }

  const [action, ...rest] = argv
  switch (action) {
    case 'sound':
      playSound(rest[0])
      break
    case 'notify':
      notify(rest.join(' ') || 'Claude Code')
      break
    case 'list':
      for (const a of ACTIONS) console.log(a.id.padEnd(26), a.desc)
      break
    default:
      console.error(`hook.mjs: unknown action ${action ?? '(none)'}`)
      console.error('try: sound <Event> | notify <text> | list')
      process.exitCode = 2
  }
  // Do not wait on the detached player.
  process.stdin.pause?.()
}

// Run only when invoked directly. pathToFileURL is required here: on Windows a
// hand-built `file://C:/...` has two slashes where import.meta.url has three,
// so a string comparison never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
