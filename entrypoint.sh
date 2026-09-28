#!/bin/sh
# Runs as root only long enough to make the Railway volume writable by the
# unprivileged service user, then drops privileges for the gate and daemon.
set -eu

OPENFANG_HOME="${OPENFANG_HOME:-/data}"
export OPENFANG_HOME

mkdir -p "$OPENFANG_HOME"

if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u "$OPENFANG_HOME")" != "$(id -u openfang)" ]; then
    chown openfang:openfang "$OPENFANG_HOME"
  fi
  # Adopt files written by an earlier root-running deployment without
  # walking a large volume on every boot.
  find "$OPENFANG_HOME" -maxdepth 1 ! -user openfang -exec chown -h openfang:openfang {} + 2>/dev/null || true
  chmod 700 "$OPENFANG_HOME"
  exec gosu openfang node /app/gate/server.js
fi

exec node /app/gate/server.js
