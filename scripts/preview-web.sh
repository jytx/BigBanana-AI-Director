#!/bin/bash
# 以前端构建产物启动本地预览服务器（验证 dist/ 生产包）
# 用法：./scripts/preview-web.sh [端口]，默认 4173
set -e

cd "$(dirname "$0")/.."

PORT="${1:-4173}"

if [ ! -d dist ]; then
  echo "[preview] 未检测到构建产物，先执行构建..."
  npm run build
fi

echo "[preview] 启动 Vite 预览服务器：http://localhost:${PORT}"
exec npx vite preview --port "${PORT}" --host
