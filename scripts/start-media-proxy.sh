#!/bin/bash
# 本地启动 media-proxy 服务（默认 8787 端口）
set -e
cd "$(dirname "$0")/.."
MEDIA_PROXY_PORT="${MEDIA_PROXY_PORT:-8787}" node server/mediaProxyServer.mjs
