# lazy-claude

A terminal front-end for Claude Code — everything before, between and around a
session. Claude owns what happens during one.

Node 18+, **zero dependencies**, one command: `cl`. Windows, macOS and Linux.

```sh
git clone https://github.com/<you>/lazy-claude.git ~/src/lazy-claude
cd ~/src/lazy-claude && ./install.sh      # Windows: powershell -File install.ps1
cl
```

The installer writes a small `cl` shim pointing back at wherever you cloned it,
and tells you if that directory is not on your PATH. `./install.sh --check`
reports without changing anything.

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
[ ] 1-6 tab      switch screen             ctrl-f/b page down / up
/                search                    d        delete (same as x)
enter            act on the selection      esc      back
q                quit                      ?        keys for this screen
`                toggle the usage summary bar
```

`h`/`l` move between screens *unless* the current screen uses left/right for
its own navigation — Launch cycles its enums, the JSON tree folds branches.
`[` and `]` always switch screens. Keys are never remapped while you are typing
into a filter or a prompt.

Translation happens once, in `tui/vim.mjs`, so screens only ever handle the
canonical names (`up`, `down`, `left`, `right`, `home`, `end`, `pageup`,
`pagedown`). A new screen gets vim navigation without doing anything.

### Mouse

```
wheel            scroll the list
click            select a row, or a tab in the header
click again      open the selected row
```

Clicking the row that is already selected activates it — the same idiom
lazygit uses, and it avoids depending on double-click timing. On Launch,
clicking directly on a checkbox toggles that flag. Mouse reporting (SGR, so it
works past column 223) is enabled on entry and disabled on exit, and never
turned on when output is piped.

## Screens

Six, reached with `1`–`6`, `[`/`]`, or Tab. Each fills the terminal. cl opens
on Dispatch when something is running, otherwise on Sessions.

**1 Dispatch** — what is running right now, and what it is doing. One row per
live session, sorted so anything waiting on you comes first, then whatever is
working, then idle. The detail pane shows the model, context as a gauge, output
tokens, tool count, and the current activity — the tool being run or the text
being written — read from the tail of the transcript. `w` jumps to the next
session that needs you.

```
context  522k / 1M                          52%
         ████████████████████▌──────────────────
```

The gauge turns amber past 60% and red past 85%. The window is inferred from
the count, not the model name: a 1M-context session still reports itself as
plain `claude-opus-5`, so the only honest signal is that it has already passed
200k.

Updates on its own: a one-second poll plus a watch on `sessions/`, so status
changes appear without touching the keyboard. While something is working the
redraw rate rises to the spinner's frame rate, so the animation reads as
rotation rather than flicker. A `!` in the header appears on every screen when
a session is waiting on input.

**2 Sessions** — every session ever run, grouped Live / Pinned / Recent, with
detail on the right. `enter` resumes, `p` pins, `x` deletes, `/` filters.

**3 Launch** — everything that becomes a CLI argument: model, effort, agent,
name, directory, prompt, and the flag groups. The resulting command is rendered
at the bottom on every keystroke, so there is no separate confirm step. `s`
saves the configuration as a profile.

**4 Stats** — one scrollable page of everything the transcripts can tell you:
totals, a rolling 5-hour window, today, a 12-hour sparkline, turns per day,
which hours you work, and breakdowns by project, tool, model, skill and plugin.

Every chart is single-series and drawn in one hue, with the numbers printed
beside the bars — nothing here needs colour to be read, and no categorical
palette is shipped. Status colours stay reserved for things that mean a state.

`` ` `` toggles a one-line summary of the same figures under any screen.

Two deliberate omissions:

- **The 5-hour figure is a rolling window over your own history, not a
  rate-limit reading.** Claude does not write its usage limits to disk, so cl
  cannot tell you how much quota is left, and does not pretend to.
- **No cost.** Transcripts record tokens, not money. A dollar figure would have
  to come from a hardcoded price table that drifts silently, so cl reports
  tokens and stops there.

**5 Config** — the persistent settings, each with a typed editor: defaults,
hooks, permissions, plugins, MCP, statusline, keybindings, environment, memory.
`R` opens a raw JSON tree for anything the forms do not cover, `U` switches
between the user and local settings files, `B` restores a backup.

**6 Data** — project directories with sizes and session counts, the cache
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

Clone anywhere; nothing assumes a particular location.

```sh
./install.sh              # macOS / Linux  -> ~/.local/bin/cl
./install.sh --check      # report only, change nothing
```

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1    # -> %USERPROFILE%in\cl.cmd
```

Both call `install.mjs`, which resolves the checkout's own path, writes the
shim, warns if its directory is not on PATH, and reports hooks still pointing
at an older checkout. Re-running is safe.

`npm link` also works if you prefer that.

### Where things live

| | |
|---|---|
| **Code** | wherever you cloned it — resolved at runtime, never assumed |
| **State** | `~/.claude/launcher/` (pins, profiles, backups) — override with `CL_DATA_DIR` |
| **Claude's config** | `~/.claude/` — override with `CLAUDE_CONFIG_DIR`, which cl honours |

State lives outside the checkout on purpose, so `git pull` never touches your
pins or profiles and the working tree stays clean.

### Updating

```sh
git -C <checkout> pull
```

That is all — unless the checkout moved, in which case re-run the installer so
the shim and any hook commands point at the new path.

## Layout

```
cl.mjs                entry: argument parsing, screen loop
install.mjs           cross-platform shim installer
app.mjs               shell: screen stack, key loop, launch transition
launch.mjs            config → argv, and running claude
hook.mjs              portable hook shim
doctor.mjs            installation check
migrate.mjs           one-time import from the PowerShell launcher

tui/                  screen (back-buffer diff renderer), keys, vim, theme,
                      widgets, charts, width
data/                 paths, json (the only writer), settings, sessions,
                      projects, usage, state
screens/              dispatch, sessions, launch, stats, config, data
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
