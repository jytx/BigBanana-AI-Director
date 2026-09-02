/**
 * cutos-api 服务入口
 *
 * 组装三组路由并监听端口（默认 8789）：
 * - /api/cutos    CutOS 剪辑助手 Agent 与音视频处理
 * - /api/jianying 剪映草稿导出
 * - /api/agent    短剧导演 Agent 与会话管理
 *
 * 对应镜像中的启动命令：node protected/cutos-api.cjs
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import express from 'express';
import { createCutosRouter } from './cutos/routesCutos.mjs';
import { createJianyingRouter } from './cutos/routesJianying.mjs';
import { createAgentRouter } from './cutos/routesAgent.mjs';

/** 服务监听端口 */
const PORT = Number.parseInt(process.env.CUTOS_API_PORT || '8789', 10);

/** 构建 Express 应用（导出以便集成测试复用） */
export const buildApp = () => {
  const app = express();
  app.use('/api/cutos', createCutosRouter());
  app.use('/api/jianying', createJianyingRouter());
  app.use('/api/agent', createAgentRouter());
  return app;
};

buildApp().listen(PORT, '0.0.0.0', () => {
  console.log(`[cutos-api] listening on :${PORT}`);
});
