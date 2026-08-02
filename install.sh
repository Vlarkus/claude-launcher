#!/bin/sh
# Install the `cl` shim on macOS or Linux.
#
#   ./install.sh
#
# Writes ~/.local/bin/cl and tells you if that directory is not on PATH.
# Idempotent: safe to re-run.

set -eu

LAUNCHER="$HOME/.claude/launcher/cl.mjs"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
SHIM="$BIN_DIR/cl"

printf '\n\033[36mcl — install\033[0m\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  \033[31mx\033[0m node is not on PATH. Install Node 18 or newer first.\n'
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '  \033[31mx\033[0m node %s is too old — cl needs 18 or newer.\n' "$(node --version)"
  exit 1
fi
printf '  \033[32m+\033[0m node %s\n' "$(node --version)"

if [ ! -f "$LAUNCHER" ]; then
  printf '  \033[31mx\033[0m launcher not found at %s\n' "$LAUNCHER"
  exit 1
fi
printf '  \033[32m+\033[0m launcher %s\n' "$LAUNCHER"

mkdir -p "$BIN_DIR"
cat > "$SHIM" <<'EOF'
#!/bin/sh
exec node "$HOME/.claude/launcher/cl.mjs" "$@"
EOF
chmod +x "$SHIM"
printf '  \033[32m+\033[0m shim    %s\n' "$SHIM"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    printf '  \033[32m+\033[0m PATH    already contains %s\n' "$BIN_DIR"
    ;;
  *)
    printf '  \033[33m!\033[0m PATH    %s is not on PATH\n' "$BIN_DIR"
    printf '            add this to your shell profile:\n'
    printf '            export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

# The hook shim needs to be executable if it is ever invoked directly.
chmod +x "$HOME/.claude/launcher/hook.mjs" 2>/dev/null || true

printf '\n  run: cl\n  check: cl doctor\n\n'
