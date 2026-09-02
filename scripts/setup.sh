#!/bin/bash
# 安装项目依赖（含服务端新增依赖）
set -e
cd "$(dirname "$0")/.."
npm install
echo "[setup] 依赖安装完成"
