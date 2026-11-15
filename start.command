#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; read -p "Press Enter"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
(sleep 2; open http://localhost:3000) &
node --no-warnings server/index.js
