#!/bin/bash
# 构建受保护（混淆）服务端产物到 server/protected/
set -e
cd "$(dirname "$0")/.."
node scripts/build-obfuscated-server.mjs
