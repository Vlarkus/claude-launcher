#!/bin/sh
# Thin wrapper so `./install.sh` works out of habit. The real installer is
# install.mjs — cross-platform, and it resolves this checkout's location
# itself. Pass --check to see what it would do without changing anything.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  printf '\033[31mx\033[0m node is not on PATH. Install Node 18 or newer first.\n' >&2
  printf '    Ubuntu/Debian:  sudo apt install nodejs\n' >&2
  printf '    or via nvm:     https://github.com/nvm-sh/nvm\n' >&2
  exit 1
fi

exec node "$DIR/install.mjs" "$@"
