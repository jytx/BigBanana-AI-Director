/**
 * /api/jianying 路由组（剪映草稿导出）
 *
 * capabilities：探测本机剪映草稿目录可用性；
 * export：校验并写入完整剪映草稿（含媒体文件）。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import express from 'express';
import { detectDraftRoot } from './jianyingPaths.mjs';
import { exportJianyingDraft } from './jianyingExport.mjs';

/** 请求体大小上限（媒体以 base64 内联，需要放宽到 2GB 量级） */
const BODY_LIMIT = process.env.JIANYING_BODY_LIMIT || '2gb';

/**
 * 挂载 /api/jianying 路由
 * @returns {import('express').Router}
 */
export const createJianyingRouter = () => {
  const router = express.Router();
  router.use(express.json({ limit: BODY_LIMIT }));

  // 草稿目录能力探测
  router.get('/capabilities', async (_req, res) => {
    try {
      res.json(await detectDraftRoot());
    } catch (error) {
      res.status(500).json({
        available: false,
        reason: error?.message || 'Capability check failed.',
      });
    }
  });

  // 草稿导出（目录不可用返回 503，载荷非法返回 400）
  router.post('/export', async (req, res) => {
    try {
      res.json(await exportJianyingDraft(req.body));
    } catch (error) {
      const status = error?.code === 'JIANYING_ROOT_UNAVAILABLE'
        || error?.code === 'JIANYING_ROOT_NOT_WRITABLE'
        ? 503
        : 400;
      console.error('[Jianying Export] Error:', error);
      res.status(status).json({ error: error?.message || 'Jianying draft export failed.' });
    }
  });

  return router;
};
