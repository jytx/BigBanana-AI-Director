#!/bin/bash
# 本地启动 new-api-proxy 服务（默认 8788 端口）
set -e
cd "$(dirname "$0")/.."
NEW_API_PROXY_PORT="${NEW_API_PROXY_PORT:-8788}" node server/newApiProxyServer.mjs
