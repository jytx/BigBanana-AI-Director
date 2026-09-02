#!/bin/bash
# 本地启动 cutos-api 服务（默认 8789 端口）
set -e
cd "$(dirname "$0")/.."
CUTOS_API_PORT="${CUTOS_API_PORT:-8789}" node server/cutosApiServer.mjs
