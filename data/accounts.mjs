// Which Claude subscription a session runs under.
//
// Claude Code keeps a whole identity — OAuth token, settings, history, MCP —
// inside CLAUDE_CONFIG_DIR. Point it somewhere else and you get a different
// account, which is how two subscriptions run side by side on one machine.
//
// cl stores only a label and a directory. The token lives in
// <dir>/.credentials.json, which belongs to Claude Code; nothing here reads,
// copies or logs it. That matters because this repo is public: the worst a
// leak of cl's state could expose is two directory paths.

import fs from 'node:fs'
import path from 'node:path'
import { HOME, CLAUDE_DIR } from './paths.mjs'
import { loadState, saveState } from './state.mjs'

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')

// Defaults matching the two-subscription setup. Both are explicit — neither
// relies on Claude Code's built-in default — so the account in play is always
// something you chose rather than something you inherited.
export const DEFAULT_ACCOUNTS = [
  { id: 'max', label: 'Max', dir: `${norm(HOME)}/.claude` },
  { id: 'pro', label: 'Pro', dir: `${norm(HOME)}/.claude-pro` },
]

export function listAccounts() {
  const st = loadState()
  const saved = Array.isArray(st.accounts) && st.accounts.length ? st.accounts : DEFAULT_ACCOUNTS
  return saved
    .filter((a) => a && a.id && a.dir)
    .map((a) => ({
      id: String(a.id),
      label: String(a.label || a.id),
      dir: norm(a.dir),
      color: a.color || null,
      exists: dirUsable(norm(a.dir)),
    }))
}

export function saveAccounts(accounts) {
  const st = loadState()
  // Store the pointer only — never anything read out of the config dir.
  st.accounts = accounts.map((a) => ({
    id: a.id, label: a.label, dir: norm(a.dir), ...(a.color ? { color: a.color } : {}),
  }))
  saveState()
  return listAccounts()
}

// A directory is usable as an account once it holds a credential file; before
// that it is just an empty folder waiting for `claude /login`.
function dirUsable(dir) {
  try {
    return fs.existsSync(path.join(dir, '.credentials.json'))
  } catch {
    return false
  }
}

// The account cl itself is running under, decided by the environment it was
// started with. Falls back to matching the resolved config dir, so it is still
// right when CLAUDE_CONFIG_DIR is unset.
export function activeAccount(accounts = listAccounts()) {
  const current = norm(process.env.CLAUDE_CONFIG_DIR || CLAUDE_DIR)
  const hit = accounts.find((a) => a.dir.toLowerCase() === current.toLowerCase())
  if (hit) return hit
  // Unknown directory: report it honestly rather than mislabelling it as one
  // of the known two.
  return { id: 'other', label: path.basename(current) || 'other', dir: current, exists: dirUsable(current), unknown: true }
}

export function accountById(id, accounts = listAccounts()) {
  return accounts.find((a) => a.id === id) || null
}

// Environment for a spawned session. Only CLAUDE_CONFIG_DIR is set; everything
// else the child needs it already inherits.
export function envFor(account) {
  if (!account?.dir) return { ...process.env }
  return { ...process.env, CLAUDE_CONFIG_DIR: account.dir }
}

// Which Anthropic account a directory is signed in as.
//
// Claude Code writes .claude.json inside CLAUDE_CONFIG_DIR (verified: it
// resolves that path from the same variable), and the address is the only way
// to confirm the two directories really are two different accounts rather than
// the same one twice. Read for display only — the credential file next to it
// is never opened for this.
const emailCache = new Map()

export function accountEmail(account) {
  const file = path.join(account?.dir || '', '.claude.json')
  let st
  try { st = fs.statSync(file) } catch { return null }
  const hit = emailCache.get(file)
  if (hit && hit.mtime === st.mtimeMs) return hit.email
  let email = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const e = raw?.oauthAccount?.emailAddress
    email = typeof e === 'string' ? e : null
  } catch { /* unreadable, huge, or not JSON */ }
  emailCache.set(file, { mtime: st.mtimeMs, email })
  return email
}

// Subscription tier as Claude Code recorded it, for display only. Reads a
// single field and never the token beside it.
const tierCache = new Map()

export function subscriptionTier(account) {
  const file = path.join(account?.dir || '', '.credentials.json')
  let st
  try { st = fs.statSync(file) } catch { return null }
  const hit = tierCache.get(file)
  if (hit && hit.mtime === st.mtimeMs) return hit.tier
  let tier = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const t = raw?.claudeAiOauth?.subscriptionType
    tier = typeof t === 'string' ? t : null
  } catch { /* unreadable or not JSON */ }
  tierCache.set(file, { mtime: st.mtimeMs, tier })
  return tier
}
