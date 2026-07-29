#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="$(python3 - <<'PY'
import socket
for port in range(4300, 4401):
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        continue
    else:
        print(port)
        sock.close()
        break
PY
)"
LOCAL_URL="http://localhost:${PORT}"

if [ ! -d node_modules ]; then
  echo "Installing project dependencies..."
  npm install
fi

echo "Building Hummely for phone testing..."
npm run build

cleanup() {
  if [ -n "$PREVIEW_PID" ] && kill -0 "$PREVIEW_PID" 2>/dev/null; then
    kill "$PREVIEW_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting local preview at ${LOCAL_URL}"
npm run preview -- --host 0.0.0.0 --port "$PORT" > /tmp/hummely-preview.log 2>&1 &
PREVIEW_PID=$!

sleep 3

echo ""
echo "Hummely phone test is ready."
echo "1. Keep this Terminal window open."
echo "2. Wait for the HTTPS address below."
echo "3. Open it on your phone with Safari or Chrome."
echo "4. Install to Home Screen if you want the app-like experience."
echo ""
echo "Local preview: ${LOCAL_URL}"
echo ""

ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:"$PORT" nokey@localhost.run
