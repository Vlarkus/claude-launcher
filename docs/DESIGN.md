# cl — design

A terminal front-end for Claude Code. Everything before, between, and around a
session; Claude itself owns what happens during one.

Replaces the PowerShell `launcher.ps1` (685 lines, Windows-only).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shape | Home base you return to, with a fast lane | Jump into a recent/pinned chat in two keystrokes; edit anything configurable when you want to |
| Config depth | Typed forms + raw JSON fallback | Common edits stay safe and validated; nothing is ever unreachable |
| Substrate | Node, zero npm dependencies | PowerShell 5.1 cannot round-trip `settings.json` safely; Node is on all three platforms |
| Portability | Windows, macOS, Linux all first-class | Same code path everywhere; OS differences isolated to two modules |
| Per-OS hooks | Portable shim (`hook.mjs`) | `settings.json` stays byte-identical across machines and is never generated |

### Why not PowerShell

PS 5.1 `ConvertFrom-Json` has no `-AsHashtable`; `ConvertTo-Json` reorders keys,
escapes non-ASCII as `\uXXXX`, and truncates past `-Depth`. A tool whose whole
job is editing `settings.json` cannot be built on a JSON round-trip that mangles
the file. PS 5.1 is also Windows-only, and pwsh 7 is not installed.

### Why zero dependencies

`cl` runs many times a day. No `node_modules`, no install step, no lockfile, and
cold start stays around 60ms. Moving to another machine is `git clone` plus a
shim.

## Organizing principle: lifetime

Every option `cl` touches falls into one of three lifetimes. This is what
separates the screens.

**A. Per-launch** — chosen fresh, becomes CLI arguments, persisted only if saved
as a profile.

    model · effort · agent · session name · initial prompt
    --continue --resume --fork-session --worktree --tmux --bg
    --bare --safe-mode --chrome --ide --verbose --debug
    --add-dir --tools --allowed-tools --disallowed-tools --max-budget-usd

**B. Persistent** — written to `settings.json`, `settings.local.json`,
`keybindings.json`, `.claude.json`.

    defaults (model, effortLevel, theme, tui, autoUpdatesChannel, verbose)
    hooks · permissions · enabledPlugins · MCP servers
    statusline · keybindings · notifications & sounds · env

**C. On disk** — 25 project directories, 200MB+ of session history.

    projects/<encoded-cwd>/<uuid>.jsonl   session transcripts
    sessions/<pid>.json                   live sessions (pid, status, name)
    history.jsonl · backups/ · cache/ · debug/ · shell-snapshots/

## Screens

Four top-level screens, reached with `1`–`4` or Tab. Every screen fills the
terminal edge to edge — no centered floating box.

### Rule for previews

> Items with detail worth reading get a two-pane list+preview.
> Items that are a toggle or an enum own the screen alone, with a single
> description line at the bottom.

| Screen | Layout | Reason |
|---|---|---|
| Sessions | two-pane | a session has a name, project, age, size, last prompt |
| Launch | full-width | every row is an enum or a toggle |
| Config → Hooks | two-pane | a hook has an event, matcher, command |
| Config → Permissions | two-pane | a rule has a pattern and a scope |
| Config → MCP | two-pane | a server has a command, args, env |
| Config → Plugins | full-width | checkboxes |
| Config → Defaults | full-width | enums |
| Config → Notifications | full-width | toggles |
| Data | two-pane | a project has size, session count, last use |

### 1 — Sessions (home)

Landing screen. The fast lane: arrow, Enter, you are in.

    cl                                     opus·1m · high · 6 plugins ─┐
    ─────────────────────────────────────┬──────────────────────────────
     LIVE                                │ launcher rewrite
     ● launcher rewrite  ~/       busy   │ ──────────────────────────────
                                         │ project   ~/
     PINNED                              │ started   2m ago
     ★ landing page      web-app   1h    │ model     opus·1m
     ★ vision pipeline   robotics  14d   │ size      344 KB · 148 msgs
                                         │ status    ● busy (pid 35444)
     RECENT                              │
       api refactor      api        3d   │ last prompt
       timeline sweep    charts    12d   │ "make the layout read like lazygit…"
       donation form     payments  21d   │
    ─────────────────────────────────────┴──────────────────────────────
     enter resume  n new  p pin  x delete  / search  1234 screens  ? q

Live sessions come from `sessions/*.json` and show `busy`/`idle` with a colour
dot. Enter on a live session attaches; Enter on any other resumes it.

### 2 — Launch

Everything that becomes a CLI argument. No preview pane — each row is a picker.

    cl · launch                                              profile: default
    ──────────────────────────────────────────────────────────────────────
      model     ▸opus   opus·1m   sonnet   sonnet·1m   haiku   fable
      effort     low    medium   ▸high    xhigh    max
      agent      (none)
      name       (none)
      dir        ~/

      plugins   [x]superpowers [x]context7 [x]playwright [x]vercel
                [x]frontend-design [x]typescript-lsp

      session   [ ]continue  [ ]fork  [ ]worktree  [ ]tmux  [ ]background
      safety    [x]skip-permissions  [ ]bare  [ ]safe-mode
      debug     [ ]verbose  [ ]debug  [ ]chrome  [ ]ide

      budget     (none)          tools     default
    ──────────────────────────────────────────────────────────────────────
      Thorough. Multi-step planning, testing.
      claude --model opus --effort high --dangerously-skip-permissions
    ──────────────────────────────────────────────────────────────────────
     enter launch  s save profile  L load  r reset  esc back

The command preview is always visible, so there is no separate confirm screen —
that was one of the "excessive" steps.

### 3 — Config

Menu, then drill in. `Esc` steps back one level.

    cl · config                                    user · ~/.claude/settings.json
    ──────────────────────────────────────────────────────────────────────
      ▸ Defaults          opus·1m · high · dark · fullscreen
        Hooks             4 events · 5 hooks
        Permissions       6 allow · 0 deny · mode default
        Plugins           6 of 6 enabled
        MCP servers       none
        Statusline        ~/.claude/statusline.sh
        Keybindings       0 custom
        Notifications     input ✓  push ✓  voice ✓
        Environment       0 variables
        Memory            CLAUDE.md · 2 files
    ──────────────────────────────────────────────────────────────────────
     enter open  R raw JSON  U switch user/local  B backups  esc back

`R` opens a collapsible JSON tree on whichever file the current section belongs
to — the escape hatch for anything the typed forms do not cover, including
settings that do not exist yet.

`U` toggles between `settings.json` and `settings.local.json`.

### 4 — Data

Disk and history management.

    cl · data                                          217 MB across 25 projects
    ─────────────────────────────────────┬──────────────────────────────
     PROJECTS                            │ robotics
     ▸ robotics                76M   31  │ ──────────────────────────────
       charts                  63M   28  │ path    ~/projects/robotics
       web-app                 25M   19  │ exists  yes
       sandbox                9.8M   12  │ 31 sessions · 76 MB
       ~/                     2.5M   16  │ oldest  2026-02-11
       api (deleted)           1.2M    4 │ newest  2026-07-28
                                         │
     CACHES                              │ sessions
       cache/                  41M       │   vision pipeline      14d  8M
       debug/                  12M       │   telemetry pass       19d  4M
    ─────────────────────────────────────┴──────────────────────────────
     x delete  X prune old  o open folder  enter drill in  esc back

Projects whose directory no longer exists are flagged — that is the main thing
worth deleting.

## Architecture

    ~/.claude/launcher/
      cl.mjs                entry: arg parsing, screen loop, teardown
      hook.mjs              portable hook shim, invoked from settings.json
      doctor.mjs            cl doctor — verify shim, node, paths, settings
      install.ps1           Windows shim install
      install.sh            macOS/Linux shim install

      tui/
        screen.mjs          back-buffer, diff renderer, alt-screen, resize
        keys.mjs            raw-mode stdin, escape-sequence decoding
        theme.mjs           colour tokens, 256/truecolor/no-colour fallback
        widgets.mjs         list, checkbox row, enum row, text input, modal

      data/
        paths.mjs           platform-aware ~/.claude locations
        json.mjs            order-preserving read / atomic backup+write
        settings.mjs        typed accessors over settings files
        sessions.mjs        scan projects/ and sessions/, parse titles
        projects.mjs        project dirs, sizes, existence
        state.mjs           launcher state: pins, profiles, last-used

      screens/
        sessions.mjs  launch.mjs  config.mjs  data.mjs
        config/       defaults hooks permissions plugins mcp
                      statusline keybindings notifications env raw

### Boundaries

`data/` never draws. `tui/` never reads config. `screens/` composes both and
holds no persistent state of its own. Any screen can be understood without
reading another.

### Writing config safely

`data/json.mjs` is the only module that writes. Every write:

1. parses the current file, keeping key order
2. applies the change to the parsed object
3. serialises with 2-space indent and a trailing newline
4. writes to `<file>.tmp`, then renames over the target (atomic)
5. keeps the previous version in `launcher/backups/<file>.<timestamp>.json`

A malformed target file aborts the write and surfaces the parse error rather
than overwriting.

### Launching

Node spawns Claude with `stdio: 'inherit'`, so Claude gets the real terminal.
The old temp-file handoff — launcher writes `%TEMP%\cl-launch.cmd`, exits, and
the parent `cl.cmd` runs Claude — is removed. `cl` becomes a plain command
rather than a shell function, and the duplicate copy in the PowerShell profile
goes away.

*To verify on Windows during implementation.* If `stdio: 'inherit'` does not
give Claude a TTY there, fall back to the existing handoff on win32 only; the
POSIX path is unaffected either way.

On exit, `cl` returns to the Sessions screen unless launched with `--go`.

### Pins

`launcher/state.json`:

    { "pins": [ { "project": "C--Users-you",
                  "sessionId": "4b419a94-…",
                  "label": "SysConfig" } ],
      "profiles": { … },
      "lastUsed": { … } }

A pin is a pointer, nothing more. Resuming a pin runs the same code as resuming
a recent session: `cd <project cwd>` then `claude --resume <uuid>`. The new
session path never reads pins.

This matters: pins were built once before (2026-06-20) and removed the same day
because the saved-chat flow broke new-session launching. Keeping pins as inert
pointers, with one shared launch path, is the fix.

### Portable hooks

`settings.json` holds one command that works on every platform:

    "command": "node ~/.claude/launcher/hook.mjs sound:done"

`hook.mjs` resolves per-OS:

    win32   powershell -WindowStyle Hidden -File ~/.claude/sounds/play.ps1 done
    darwin  afplay ~/.claude/sounds/done.wav
    linux   paplay ~/.claude/sounds/done.wav

Cost is one extra process per hook, roughly 40ms. The gain is a `settings.json`
that is identical on every machine and syncs with no transformation.

Existing hooks are left alone. `cl` offers to convert them and shows the diff
before writing.

## Migration

1. `launcher.ps1` stays in git history and as a timestamped backup.
2. `presets.json` (100KB — a full hooks blob was serialised into it) is read
   once to import profiles, then archived.
3. Orphan `session-*.json` and `settings.backup.json` are removed.
4. `bin/cl.cmd` becomes a one-line call to `node cl.mjs`.
5. The `cl` function is removed from the PowerShell profile; `clq`/`cld` stay.

## Not doing

- Customising a running Claude session. Not possible from outside the process;
  `/config`, `/model`, `/effort` already cover it.
- Reimplementing the resume picker. `claude --resume` is fine when you know what
  you want; the Sessions screen exists for when you do not.
- Mouse support.
