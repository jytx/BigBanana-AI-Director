# BigBanana-AI-Director 3.4.1 服务端源码恢复报告

> 恢复日期：2026-09-02
> 基线：git 提交 `5b5be3b`（仓库最后一个含源码的提交）
> 目标：对齐官方闭源镜像 `bigbanana-ai-director:*-3.4.1` 的服务端功能

## 一、版本历史结论

| 事实 | 说明 |
|---|---|
| 最后含源码提交 | `5b5be3b`（Merge branch 'main'，位于 tag 2.0.3 之后 4 个提交） |
| 闭源切换 | `5b5be3b` 之后的 50 条提交逐步删除源码，仅保留 README / compose / 截图 |
| 闭源版 tag | `3.0.1` ~ `3.4.1` 全部为闭源版（无任何代码） |
| 版本对应 | `5b5be3b` 源码已包含 NewApiConsole、订阅管理、日志面板等 3.4.x 前期功能 |

闭源后（3.0 → 3.4.1）的服务端增量，已全部移植/恢复到本仓库：

1. **media-proxy**：默认超时 120s → 300s；默认域名白名单由仅 `volces.com` 扩充为
   `volces.com / amazonaws.com / amazonaws.com.cn / aliyuncs.com / aliyuncs.com.cn / tree456.com`
2. **new-api-proxy**：新增 6 项能力——`aff`（邀请返利）、`aff_transfer`、
   `subscription/self/preference`（订阅偏好 PUT）、`checkin`（签到 GET/POST）、
   `tokens/:id/key`（重生成密钥）、`/api/antsk-proxy` 透明流式网关（默认指向
   `https://api.antsk.cn`，含 SSRF 校验与 15 分钟超时）
3. **cutos-api**（全新服务，源码从未公开）：从镜像反混淆代码完整重写

## 二、cutos-api 恢复明细

从 3.4.1 镜像内 `protected/cutos-api.cjs`（javascript-obfuscator 混淆）经 webcrack
还原为 2097 行可读代码后，按模块重写为以下源码（共 17 个文件，全部中文注释）：

| 文件 | 职责 |
|---|---|
| `server/cutosApiServer.mjs` | 服务入口：组装三组路由并监听 8789 |
| `server/cutos/httpHelpers.mjs` | NDJSON 流式响应、apiBase 相对路径解析、base64/dataURL 工具 |
| `server/cutos/agentRuntime.mjs` | KODE Agent 运行时：Provider 构建、模板注册、流式对话循环、事件映射 |
| `server/cutos/agentSessions.mjs` | Agent 会话列表 / 统计 / 重置（.kode-bigbanana JSONStore） |
| `server/cutos/dramaTools.mjs` | 短剧生产工具链（15 个工具：剧本分析→分镜→生图→生视频→配音） |
| `server/cutos/cutosTools.mjs` | CutOS 剪辑工具链（14 个工具）+ 时间线系统提示词 |
| `server/cutos/routesAgent.mjs` | `/api/agent`：drama 同步/流式、sessions 管理 |
| `server/cutos/routesCutos.mjs` | `/api/cutos`：剪辑 Agent、转写、字幕、配音、人声隔离、Vidu 代理、MP4 导出 |
| `server/cutos/routesJianying.mjs` | `/api/jianying`：草稿目录探测、草稿导出 |
| `server/cutos/jianyingPaths.mjs` | 剪映草稿目录候选（Win/Mac）、能力检测、文件名清洗、路径穿越防护 |
| `server/cutos/jianyingExport.mjs` | 导出载荷校验（素材引用/时间区间/大小限额）+ 草稿四件套落盘（临时目录原子重命名） |
| `server/cutos/audioService.mjs` | ffmpeg 音频抽取/人声隔离/MP4 转码 + DashScope `qwen3-livetranslate-flash` 转写/字幕/配音 |
| `server/cutos/viduProxy.mjs` | Vidu（api.vidu.cn）视频生成 API 代理，仅放行 `/ent/v2/` 前缀 |

外部依赖（BYOK 模式）：
- LLM：任意 OpenAI 兼容端点（`modelConfig.apiKey/model/apiBase` 由前端传入，
  相对路径自动拼接当前站点，可对接 `/api/antsk-proxy` 网关）
- DashScope 阿里云百炼：语音转写 / 字幕 / 配音（`DASHSCOPE_API_KEY` 可作服务端兜底）
- Vidu 生数科技：视频生成

## 三、周边文件恢复

| 文件 | 说明 |
|---|---|
| `server/newApiGateway.mjs` | 新增：antsk 透明流式网关（独立模块，http/https pipe 转发） |
| `scripts/build-obfuscated-server.mjs` | 新增：esbuild 打包 + javascript-obfuscator 混淆 → `server/protected/*.cjs`（npm 依赖全部 external，与官方产物规模对齐） |
| `Dockerfile.cutos-api` | 新增：多阶段构建（builder 混淆 → runtime 生产依赖 + protected 产物），启动命令与官方镜像一致 |
| `nginx.conf` | 按 3.4.1 镜像更新：新增 `/api/antsk-proxy`、`/api/cutos`、`/api/jianying`、`/api/agent` 反代，代理超时 300s → 1800s，`client_max_body_size` 10m → 100m（jianying 单独 2g） |
| `docker-compose.yaml` | 对齐 3.4.1 形态：容器命名 `bigbanana-ai-director-*`、新增 cutos-api 服务（含 `DASHSCOPE_API_KEY`），保留本地构建 |
| `package.json` | 新增依赖 `@shareai-lab/kode-sdk`、`express`、`zod`、`ffmpeg-static`；devDeps 新增 `esbuild`、`javascript-obfuscator`；scripts 新增 `cutos-api` / `new-api-proxy` / `build:server:protected` |
| `scripts/*.sh` | 新增本地 Run & Debug 脚本：`setup.sh`、`start-{media-proxy,new-api-proxy,cutos-api}.sh`、`build-server-protected.sh` |

## 四、恢复验证

1. **语法检查**：17 个服务端 `.mjs` 全部通过 `node --check`
2. **冒烟测试**：三服务均正常启动，路由校验行为正确
   （`/healthz` 返回 6 域名白名单、agent/vidu 参数校验 400、sessions 列表正常）
3. **官方镜像行为对齐**：官方 `cutos-3.4.1` 容器与恢复版同时启动对比——
   - `POST /api/cutos/agent`（空参校验）：**逐字节一致**
   - `POST /api/cutos/vidu`（缺密钥校验）：**逐字节一致**
   - `GET /api/jianying/capabilities`：结构一致，差异仅平台字段（linux/darwin、容器路径）
   - `GET /api/agent/sessions`：结构一致，`storeDir` 为各自工作目录（行为正确）
4. **混淆产物规模对齐**：
   | 产物 | 官方镜像 | 恢复版构建 |
   |---|---|---|
   | cutos-api.cjs | 110,556 B | 112,606 B |
   | new-api-proxy.cjs | 43,155 B | 48,391 B |
   | media-proxy.cjs | 11,598 B | 13,303 B |

## 五、前端现状与限制

- **保留 `5b5be3b` 前端**（含账号中心、订阅管理、日志面板等页面）。
- 官方 3.4.1 前端为闭源后重写的 "studio" 版：构建配置改为 `studio.vite.config.mts`，
  新增 radix-ui / framer-motion / i18next / dexie / tailwind-merge / react-markdown 等
  20+ 依赖，新增小说导入（novelImportService）、变形转场（morph-transition）等模块。
- 前端 bundle（7MB，minified + 字符串压缩）**无法可靠恢复 TS 源码**，本恢复版不含 studio 前端。
  若需要 CutOS 剪辑工作台 UI，需要自行开发对接 `/api/cutos` 系列接口。

## 六、已知差异（与官方 3.4.1）

1. 前端为 5b5be3b 旧版（见上节）
2. 混淆配置参数为按产物特征推测值（控制流扁平化阈值、字符串编码比例等），
   产物字节与官方不完全相同，但保护强度同级
3. 官方 new-api-proxy 含请求级 console 日志（日志面板调试用途），恢复版未保留
4. 恢复版代码带完整中文注释与 JSDoc，结构化模块拆分（官方为单文件）

## 七、使用方式

```bash
./scripts/setup.sh                  # 安装依赖
./scripts/start-cutos-api.sh        # 启动 cutos-api（8789）
./scripts/start-media-proxy.sh      # 启动 media-proxy（8787）
./scripts/start-new-api-proxy.sh    # 启动 new-api-proxy（8788）
./scripts/build-server-protected.sh # 构建混淆产物（可选）
docker compose up -d --build        # 容器化部署（web + 三个后端服务）
```
