#!/bin/bash
# 启动前端开发服务器（Vite dev，支持热更新）
# 用法：./scripts/start-web-dev.sh [端口]，默认 5173
set -e

cd "$(dirname "$0")/.."

PORT="${1:-5173}"

if [ ! -d node_modules ]; then
  echo "[web-dev] 未检测到依赖，先执行安装..."
  ./scripts/setup.sh
fi

echo "[web-dev] 启动 Vite 开发服务器：http://localhost:${PORT}"
exec npx vite --port "${PORT}" --host
