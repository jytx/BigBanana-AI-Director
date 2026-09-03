# 3.4.1 服务端源码恢复 —— 评审与前端还原可行性讨论

> 本文档为讨论用副本，正式报告见 `docs/RESTORE-3.4.1.md`。
> 基线：git 提交 `5b5be3b`（仓库最后一个含源码的提交）
> 目标：对齐官方闭源镜像 `bigbanana-ai-director:*-3.4.1` 的服务端功能
> 讨论建立时间：2026-09-02

---

## 第一部分：恢复报告全文（引自 docs/RESTORE-3.4.1.md）

### 一、版本历史结论

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

### 二、cutos-api 恢复明细

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

### 三、周边文件恢复

| 文件 | 说明 |
|---|---|
| `server/newApiGateway.mjs` | 新增：antsk 透明流式网关（独立模块，http/https pipe 转发） |
| `scripts/build-obfuscated-server.mjs` | 新增：esbuild 打包 + javascript-obfuscator 混淆 → `server/protected/*.cjs`（npm 依赖全部 external，与官方产物规模对齐） |
| `Dockerfile.cutos-api` | 新增：多阶段构建（builder 混淆 → runtime 生产依赖 + protected 产物），启动命令与官方镜像一致 |
| `nginx.conf` | 按 3.4.1 镜像更新：新增 `/api/antsk-proxy`、`/api/cutos`、`/api/jianying`、`/api/agent` 反代，代理超时 300s → 1800s，`client_max_body_size` 10m → 100m（jianying 单独 2g） |
| `docker-compose.yaml` | 对齐 3.4.1 形态：容器命名 `bigbanana-ai-director-*`、新增 cutos-api 服务（含 `DASHSCOPE_API_KEY`），保留本地构建 |
| `package.json` | 新增依赖 `@shareai-lab/kode-sdk`、`express`、`zod`、`ffmpeg-static`；devDeps 新增 `esbuild`、`javascript-obfuscator`；scripts 新增 `cutos-api` / `new-api-proxy` / `build:server:protected` |
| `scripts/*.sh` | 新增本地 Run & Debug 脚本：`setup.sh`、`start-{media-proxy,new-api-proxy,cutos-api}.sh`、`build-server-protected.sh` |

### 四、恢复验证

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

### 五、前端现状与限制（原报告结论）

- **保留 `5b5be3b` 前端**（含账号中心、订阅管理、日志面板等页面）。
- 官方 3.4.1 前端为闭源后重写的 "studio" 版：构建配置改为 `studio.vite.config.mts`，
  新增 radix-ui / framer-motion / i18next / dexie / tailwind-merge / react-markdown 等
  20+ 依赖，新增小说导入（novelImportService）、变形转场（morph-transition）等模块。
- 前端 bundle（7MB，minified + 字符串压缩）**无法可靠恢复 TS 源码**，本恢复版不含 studio 前端。
  若需要 CutOS 剪辑工作台 UI，需要自行开发对接 `/api/cutos` 系列接口。

### 六、已知差异（与官方 3.4.1）

1. 前端为 5b5be3b 旧版（见上节）
2. 混淆配置参数为按产物特征推测值（控制流扁平化阈值、字符串编码比例等），
   产物字节与官方不完全相同，但保护强度同级
3. 官方 new-api-proxy 含请求级 console 日志（日志面板调试用途），恢复版未保留
4. 恢复版代码带完整中文注释与 JSDoc，结构化模块拆分（官方为单文件）

### 七、使用方式

```bash
./scripts/setup.sh                  # 安装依赖
./scripts/start-cutos-api.sh        # 启动 cutos-api（8789）
./scripts/start-media-proxy.sh      # 启动 media-proxy（8787）
./scripts/start-new-api-proxy.sh    # 启动 new-api-proxy（8788）
./scripts/build-server-protected.sh # 构建混淆产物（可选）
docker compose up -d --build        # 容器化部署（web + 三个后端服务）
```

---

## 第二部分：前端 bundle 实测新发现（2026-09-02 会话补充）

对官方 `web-3.4.1` 镜像 `/usr/share/nginx/html/assets/` 的直接验证，
**修正原报告第五节的一个判断**：

### 实测事实

| 项目 | 实测结果 |
|---|---|
| assets 总量 | 33 个文件，共 8.9MB |
| 主 bundle | `index-SIF0oviY.js`，**6.3MB** |
| 次级 bundle | `index-D7IrjRp8.js` 572KB；`motion-*.js` 331KB（framer-motion 惰性 chunk）；`morph-transition-*.js` 13KB；`icons-*.js` 95KB |
| sourcemap | **无任何 `.map` 文件**，bundle 末尾无 `sourceMappingURL` 引用 |
| 混淆形态 | 主 bundle 开头即 `_0x` 十六进制字符串数组 + `while(!![])` 数组旋转解密——**javascript-obfuscator 特征，与服务端同一工具**；字符串被分段拼接（连 Tailwind 类名都被拆成 `_0x417b26(0x59d)+'secondar'+…`） |
| 未混淆部分 | 部分 chunk 尾部保留 esbuild 压缩形态的导出映射（`ON as c, Qp as d…`），推测惰性 chunk 仅压缩未混淆，主 chunk 混淆 |

### 与原报告结论的差异

原报告表述为「minified + 字符串压缩，无法可靠恢复 TS 源码」。实测表明主 bundle 走的是
**javascript-obfuscator 混淆**——与服务端 `protected/*.cjs` 同一工具链。这意味着：

1. **技术上存在用 webcrack 反混淆的可能性**（服务端 110KB 产物已验证此路可行），
   「完全无法还原」的说法过于绝对；
2. 但主 bundle 规模是服务端最大产物的 **57 倍**（6.3MB vs 110KB），webcrack 能否
   在可接受时间内处理完、处理后人读可维护性如何，均未验证；
3. 即便反混淆成功，得到的仍是 **Vite 打包后的编译产物**：
   - React 组件是 `jsx(...)` 运行时调用，不是 JSX/TSX 语法；
   - 全部 TypeScript 类型、接口定义、注释、原始文件边界均已丢失；
   - 还原出的代码只能做到「可读、可改」，做不到「可维护的源码工程」。

### webcrack 实测结果（2026-09-02，本讨论的核心依据）

对全部 JS 产物实际执行了 webcrack 反混淆，结果**全面好于预期**：

| 项目 | 实测结果 |
|---|---|
| 主 bundle `index-SIF0oviY.js`（6.3MB） | **54 秒完成**，字符串数组 49,305 条全部解码，反混淆 + unminify 共约 56 万处变换 |
| 产物形态 | 单文件 `deobfuscated.js`，4.37MB / **95,066 行**（webcrack 无法按模块拆分——Vite/Rollup 打平的 ESM 没有模块注册表） |
| JSX 还原 | **成功还原为 JSX 语法**（4,803 处变换）：`return <div className=...>` 结构完整，Tailwind 类名、CSS 变量设计体系（`--bg-base`、`--text-primary`…）、i18n key（`workflow:lockLeaveTitle` 等）、事件与条件渲染逻辑全部可读 |
| 业务 chunk 取样 `novelImportService`（54KB） | 还原为 696 行，**三段完整中文 prompt**（小说拆分助手 / 分集规划策划 / 短剧编剧草稿）逐字保留，数据结构与校验逻辑完整 |
| 提示词模板系统 | i18n 式模板路径全部可见：`storyboard.*`（8 条）、`keyframe.*`（9 条）、`nineGrid.*`（9 条）、`video.sora2*` 等——studio 版的 AI 能力清单完整暴露 |
| API 调用清单 | `/api/new-api/*` 全套 20 个端点（含订阅支付 stripe/creem/epay、签到、返利）清晰可数 |
| 中文文案 | 6,041 行含中文，界面文案基本完整 |
| **不可恢复** | 变量名/组件名仍是 `_0x` 乱码；TS 类型、注释、原始文件边界永久丢失 |

**规模对比**：当前仓库旧前端（`5b5be3b`）142 个 TS/TSX 文件、41,388 行；
studio 版反混淆产物 95,066 行（其中含 react/radix-ui/framer-motion/dexie/i18next 等
打入主 bundle 的第三方库代码），**业务代码量级与旧前端相当（约 3~4 万行）**。

### 与 `5b5be3b` 旧版的资产对照（关键修正）

对「studio 版功能是否都要从反混淆产物抄」做了逐项核对，**结论：大部分资产旧版源码已有，
studio 版真正净新增的只有三块**：

| 资产 | 旧版（`5b5be3b`）现状 | studio 版（3.4.1） | 是否需要抄 |
|---|---|---|---|
| 提示词库（分镜/九宫格/关键帧/视频） | **已有**：`promptTemplateService.ts` 1,228 行 + `storyboardPromptTemplates.ts`，`nineGridSourceMeta`、`optimizeBoth` 等模板全文在手 | 改为 i18n path 注册表架构（`keyframe.*` 等 35+ 条），**占位符逐字对比与旧版一致**——同一套模板的重新组织 | 不需要抄内容，至多参考注册表架构 |
| 九宫格 / 分镜 / 镜头拆分 | 已有（多个 service + docs 文档） | 同功能重写 UI | 否 |
| Sora 视频对接 | 已有（15 个文件含 sora，含 `video.sora2*` 前身） | sora2 中英文模板 | 否（微调即可） |
| 账号中心 / 订阅 / 日志面板 | 已有 | 同功能 radix-ui 重写 | 否 |
| **小说导入** | **无**（0 个文件） | `novelImportService` chunk 696 行 + 3 段完整中文 prompt | **是**（唯一大块业务逻辑） |
| **CutOS 剪辑工作台** | 无 | 对接 `/api/cutos`（服务端已恢复）的剪辑 UI | **是**（UI 从零） |
| 变形转场 morph-transition | 无 | 13KB 独立 chunk（`createMorphTransition` 导出名保真） | 可选小件 |
| i18n 双语 / dexie+OPFS 本地存储 | 无 | 架构性升级 | 按需自研 |

**此对照对路线评估的修正**：C 方案的「翻译量」从先前估计的 3~4 万行业务代码，
收敛为**净新增三块**——小说导入（696 行已在手）、CutOS 剪辑工作台 UI（需从零设计，
服务端 15+14 个工具的能力清单已恢复可依）、morph 转场（可选）。其余功能在旧版源码
中本就以有类型、有注释的形态存在，直接继续演进即可，不存在「抄」的问题。

---

## 第三部分：路线决策（已定稿）

**决策（2026-09-02）**：采用「主干演进 + 净新增回补」——
以 `5b5be3b` 旧版源码（现 `dev` 分支前端）为项目主干继续演进，
将闭源后（3.0 → 3.4.1）官方净新增的功能增量补回。

决策依据（见第二部分资产对照）：
- 提示词库、九宫格、分镜、Sora 对接、账号中心等资产旧版已有，直接演进，不涉及抄；
- 反混淆产物（保留于 `bigbanana-image-inspect/web-3.4.1/`）仅作净新增功能的参考材料；
- 上游协议 CC BY-NC-SA 允许演绎（署名 + 非商用 + 同协议），fork 定位为非商用自部署分享。

### 增量回补计划

| 阶段 | 内容 | 依赖 | 参考 | 预估 |
|---|---|---|---|---|
| 1. 小说导入 | 小说 → 分段摘要 → 分集规划 → 单集草稿，接入旧版项目创建流程 | 仅 LLM（已有 modelConfig 体系） | `deob-novel/` 696 行全文（3 段 prompt + 数据流） | 2~3 天 |
| 2. CutOS 剪辑工作台 | 时间线剪辑 UI，对接 `/api/cutos`（剪辑 Agent、转写/字幕/配音、Vidu）与 `/api/jianying`（剪映草稿导出） | cutos-api 已恢复并验证 | 服务端 29 工具清单 + 主 bundle 中 workflow 导航/时间线 UI 结构 | 1~2 周（最大块） |
| 3. 可选小件 | 变形转场 morph-transition；提示词注册表架构；i18n 双语 | — | `deob-morph/`；按需 | 按需 |

每阶段完成后与官方镜像做行为对照（接口层面逐项核对）。

### 既有待办（不变）

1. `docker compose build && up` 四容器完整编排验证——是否执行？
2. `server/protected/` 混淆产物目录是否加入 `.gitignore`？
3. 临时恢复目录 `/Users/gemini/ZCodeProject/bigbanana-restore/`（含 307M node_modules）
   清理与否，待确认；反混淆参考材料目录 `bigbanana-image-inspect/web-3.4.1/` 保留。
4. README 与使用文档更新。
