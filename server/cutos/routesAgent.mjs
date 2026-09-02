/**
 * /api/agent 路由组（短剧导演 Agent 与会话管理）
 *
 * drama（同步 + 流式）：以短剧生产工具链驱动"剧本 → 分镜 → 生成"流水线；
 * sessions：查看与重置 KODE Agent 会话。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import express from 'express';
import { runKodeAgent } from './agentRuntime.mjs';
import { buildDramaTools } from './dramaTools.mjs';
import { listAgentSessions, resetAgentSessions } from './agentSessions.mjs';
import { resolveRelativeApiBase, startNdjsonStream, writeNdjsonLine } from './httpHelpers.mjs';

/** 短剧导演 Agent 的会话模板 ID */
const DRAMA_TEMPLATE_ID = 'bigbanana-drama-kode';

/**
 * 运行短剧导演 Agent（系统提示词由前端按项目状态构造后传入）
 * @param {object} options - 与 runKodeAgent 相同，额外支持流式回调
 * @returns {Promise<object>} Agent 运行结果
 */
const runDramaAgent = ({ agentId, systemPrompt, input, modelConfig, onTextDelta, onEvent }) => runKodeAgent({
  agentId,
  templateId: DRAMA_TEMPLATE_ID,
  systemPrompt,
  input,
  modelConfig,
  toolInstances: buildDramaTools(),
  metadata: { agentKind: 'drama' },
  onTextDelta,
  onEvent,
});

/**
 * 挂载 /api/agent 路由
 * @returns {import('express').Router}
 */
export const createAgentRouter = () => {
  const router = express.Router();
  router.use(express.json({ limit: '100mb' }));

  // 短剧导演 Agent（同步响应）
  router.post('/drama', async (req, res) => {
    try {
      const body = resolveRelativeApiBase(req, req.body || {});
      const result = await runDramaAgent(body);
      res.json(result);
    } catch (error) {
      console.error('[Drama Agent] Error:', error);
      res.status(500).json({ error: error?.message || 'Drama agent request failed' });
    }
  });

  // 短剧导演 Agent（NDJSON 流式响应）
  router.post('/drama/stream', async (req, res) => {
    try {
      const body = resolveRelativeApiBase(req, req.body || {});
      startNdjsonStream(res);

      const result = await runDramaAgent({
        ...body,
        onTextDelta: ({ delta, text }) => {
          writeNdjsonLine(res, { type: 'text-delta', delta, text });
        },
        onEvent: (event) => {
          writeNdjsonLine(res, { type: 'event', event });
        },
      });
      writeNdjsonLine(res, { type: 'result', result });
    } catch (error) {
      console.error('[Drama Agent Stream] Error:', error);
      if (res.headersSent) {
        writeNdjsonLine(res, { type: 'error', error: error?.message || 'Drama agent stream failed' });
      } else {
        res.status(500).json({ error: error?.message || 'Drama agent stream failed' });
        return;
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // 会话列表（支持 prefix 前缀过滤）
  router.get('/sessions', async (req, res) => {
    try {
      const prefix = typeof req.query?.prefix === 'string' && req.query.prefix.trim()
        ? req.query.prefix.trim()
        : undefined;
      const result = await listAgentSessions({ prefix });
      res.json(result);
    } catch (error) {
      console.error('[KODE Sessions] Stats error:', error);
      res.status(500).json({ error: error?.message || 'Failed to load KODE session stats' });
    }
  });

  // 会话重置（按 agentId / prefix / resetAll 三种方式）
  router.post('/sessions/reset', async (req, res) => {
    try {
      const body = req.body || {};
      const agentId = typeof body.agentId === 'string' && body.agentId.trim()
        ? body.agentId.trim()
        : undefined;
      const prefix = typeof body.prefix === 'string' && body.prefix.trim()
        ? body.prefix.trim()
        : undefined;
      const resetAll = body.resetAll === true;

      if (!agentId && !prefix && !resetAll) {
        res.status(400).json({ error: 'Missing reset target' });
        return;
      }

      const result = await resetAgentSessions({ agentId, prefix, resetAll });
      res.json(result);
    } catch (error) {
      console.error('[KODE Sessions] Reset error:', error);
      res.status(500).json({ error: error?.message || 'Failed to reset KODE sessions' });
    }
  });

  return router;
};
