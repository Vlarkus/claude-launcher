# cl

A terminal front-end for Claude Code. Everything before, between and around a
session; Claude owns what happens during one.

Node, no dependencies. Windows, macOS and Linux.

```
cl                    open the launcher
cl -c                 continue the most recent session here, no TUI
cl -r [term]          Claude's resume picker
cl doctor             check the installation
cl hook sound Stop    run a hook action directly
```

## Keys

Vim navigation works everywhere. `?` shows the bindings for whatever is on
screen.

```
j k              down / up                 gg G     top / bottom
h l              left / right              ctrl-d/u page down / up
[ ] 1-4 tab      switch screen             ctrl-f/b page down / up
/                search                    d        delete (same as x)
enter            act on the selection      esc      back
q                quit                      ?        keys for this screen
```

`h`/`l` move between screens *unless* the current screen uses left/right for
its own navigation — Launch cycles its enums, the JSON tree folds branches.
`[` and `]` always switch screens. Keys are never remapped while you are typing
into a filter or a prompt.

Translation happens once, in `tui/vim.mjs`, so screens only ever handle the
canonical names (`up`, `down`, `left`, `right`, `home`, `end`, `pageup`,
`pagedown`). A new screen gets vim navigation without doing anything.

## Screens

Four, reached with `1`–`4`, `[`/`]`, or Tab. Each fills the terminal.

**1 Sessions** — the landing screen. Every session grouped Live / Pinned /
Recent, with detail on the right. Live sessions are read from `sessions/*.json`
and show `busy` / `idle`. `enter` resumes, `p` pins, `x` deletes, `/` filters.

**2 Launch** — everything that becomes a CLI argument: model, effort, agent,
name, directory, prompt, and the flag groups. The resulting command is rendered
at the bottom on every keystroke, so there is no separate confirm step. `s`
saves the configuration as a profile.

**3 Config** — the persistent settings, each with a typed editor: defaults,
hooks, permissions, plugins, MCP, statusline, keybindings, environment, memory.
`R` opens a raw JSON tree for anything the forms do not cover, `U` switches
between the user and local settings files, `B` restores a backup.

**4 Data** — project directories with sizes and session counts, the cache
directories, and the projects whose working directory no longer exists.

## Why options are grouped this way

By lifetime. Per-launch options become CLI arguments and are chosen fresh
(Launch). Persistent options are written to a settings file (Config). Data on
disk is neither (Sessions, Data).

Within that, one rule decides the layout: **items with detail worth reading get
a preview pane; items that are a toggle or an enum own the screen alone.**

## Writing config

`data/json.mjs` is the only module that writes. Every write parses the current
file first and aborts if it is malformed, applies the change to the parsed
object, serialises with 2-space indent, writes to a temp file and renames over
the target, and keeps the previous contents in `backups/`. A write that would
change nothing is skipped entirely, so mtimes stay put.

Round-tripping `settings.json` is byte-identical: key order, unicode and
nesting all survive.

## Portable hooks

`settings.json` holds one command that works everywhere:

```json
"command": "node ~/.claude/launcher/hook.mjs sound Stop"
```

`hook.mjs` resolves per-OS at run time — PowerShell's `SoundPlayer` on Windows,
`afplay` on macOS, `paplay`/`aplay`/`ffplay` on Linux — and synthesises the
tones itself, so there are no audio files to carry around. The settings file
stays identical on every machine.

Config → Hooks → `c` converts a platform-specific hook; `C` converts all of
them. `cl doctor` reports any that would not survive a move.

## Install

```
# Windows
powershell -ExecutionPolicy Bypass -File install.ps1

# macOS / Linux
./install.sh
```

Both write a `cl` shim and check that its directory is on PATH. Re-running is
safe.

## Layout

```
cl.mjs                entry: argument parsing, screen loop
app.mjs               shell: screen stack, key loop, launch transition
launch.mjs            config → argv, and running claude
hook.mjs              portable hook shim
doctor.mjs            installation check
migrate.mjs           one-time import from the PowerShell launcher

tui/                  screen (back-buffer diff renderer), keys, theme,
                      widgets, width
data/                 paths, json (the only writer), settings, sessions,
                      projects, state
screens/              sessions, launch, config, data
screens/config/       defaults, hooks, permissions, lists, misc, rawjson
```

`data/` never draws. `tui/` never reads config. `screens/` composes both.

## Notes

- Claude is spawned with `stdio: 'inherit'`, so it gets the real terminal. The
  old temp-file handoff is gone; set `CL_LEGACY_HANDOFF=1` to restore it.
- Plugin enablement is persistent, not per-session. There is no CLI flag for
  it, so toggling a plugin writes `settings.json` and says so. The previous
  launcher's plugin checkboxes did nothing.
- `archive/` holds the PowerShell launcher and its presets. `migrate.mjs`
  imported the launch profile and all eight hook presets into `state.json`.
