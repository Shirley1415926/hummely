#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=4173
URL="http://localhost:${PORT}"

if [ ! -d node_modules ]; then
  echo "Installing project dependencies..."
  npm install
fi

echo "Starting Hummely React demo at ${URL}"
npm run dev -- --host 0.0.0.0 --port "$PORT"
