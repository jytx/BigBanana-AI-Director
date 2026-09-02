/**
 * /api/cutos 路由组
 *
 * 提供 CutOS 剪辑助手 Agent（同步 + 流式）、语音转写、字幕生成、
 * 配音文本提取、人声隔离、Vidu 代理与 MP4 导出接口。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import express from 'express';
import crypto from 'node:crypto';
import { runKodeAgent } from './agentRuntime.mjs';
import { buildCutosSystemPrompt, buildCutosTools } from './cutosTools.mjs';
import {
  extractDubbingText,
  generateCaptions,
  isolateVoiceToWavDataUrl,
  transcribeAndTranslate,
  transcodeToMp4,
} from './audioService.mjs';
import { proxyViduRequest } from './viduProxy.mjs';
import { resolveRelativeApiBase, startNdjsonStream, writeNdjsonLine } from './httpHelpers.mjs';

/** CutOS 剪辑 Agent 的会话模板 ID */
const CUTOS_TEMPLATE_ID = 'bigbanana-cutos-kode';

/** 空时间线状态（前端未传时的兜底值） */
const EMPTY_TIMELINE = {
  clips: [],
  media: [],
  currentTimeSeconds: 0,
  selectedClipId: null,
};

/**
 * 运行 CutOS 剪辑助手 Agent
 * @param {object} options - 与 runKodeAgent 相同，额外支持流式回调
 * @returns {Promise<object>} Agent 运行结果
 */
const runCutosAgent = ({ agentId, input, timelineState, modelConfig, onTextDelta, onEvent }) => runKodeAgent({
  agentId,
  templateId: CUTOS_TEMPLATE_ID,
  systemPrompt: buildCutosSystemPrompt(timelineState || EMPTY_TIMELINE),
  input,
  modelConfig,
  toolInstances: buildCutosTools(),
  metadata: { agentKind: 'cutos' },
  onTextDelta,
  onEvent,
});

/** 校验 Agent 请求基础字段，返回错误消息或 null */
const validateAgentRequest = (body) => {
  if (!body?.input || !String(body.input).trim()) return 'Missing input';
  if (!body?.modelConfig?.apiKey || !body?.modelConfig?.model) {
    return 'Missing modelConfig.apiKey or modelConfig.model';
  }
  return null;
};

/** 依据请求 Content-Type 推断浏览器录制视频的扩展名 */
const extensionFromRequestContentType = (contentType = '') => {
  const lower = String(contentType).toLowerCase();
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('ogg')) return 'ogv';
  return 'webm';
};

/**
 * 挂载 /api/cutos 路由
 * @returns {import('express').Router}
 */
export const createCutosRouter = () => {
  const router = express.Router();
  router.use(express.json({ limit: '100mb' }));

  // 剪辑助手 Agent（同步响应）
  router.post('/agent', async (req, res) => {
    try {
      const body = resolveRelativeApiBase(req, req.body || {});
      const validationError = validateAgentRequest(body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const result = await runCutosAgent({
        agentId: String(body.agentId || 'cutos-default'),
        input: String(body.input),
        timelineState: body.timelineState,
        modelConfig: body.modelConfig,
      });
      res.json(result);
    } catch (error) {
      console.error('[CutOS Agent] Error:', error);
      res.status(500).json({ error: error?.message || 'Agent request failed' });
    }
  });

  // 剪辑助手 Agent（NDJSON 流式响应）
  router.post('/agent/stream', async (req, res) => {
    try {
      const body = resolveRelativeApiBase(req, req.body || {});
      const validationError = validateAgentRequest(body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      startNdjsonStream(res);
      const result = await runCutosAgent({
        agentId: String(body.agentId || 'cutos-default'),
        input: String(body.input),
        timelineState: body.timelineState,
        modelConfig: body.modelConfig,
        onTextDelta: ({ delta, text }) => {
          writeNdjsonLine(res, { type: 'text-delta', delta, text });
        },
        onEvent: (event) => {
          writeNdjsonLine(res, { type: 'event', event });
        },
      });
      writeNdjsonLine(res, { type: 'result', result });
    } catch (error) {
      console.error('[CutOS Agent Stream] Error:', error);
      if (res.headersSent) {
        writeNdjsonLine(res, { type: 'error', error: error?.message || 'Agent stream failed' });
      } else {
        res.status(500).json({ error: error?.message || 'Agent stream failed' });
        return;
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // 语音转写（音频 data URL → 文本）
  router.post('/transcribe', async (req, res) => {
    try {
      const { audioDataUrl, apiKey, targetLang = 'zh' } = req.body || {};
      const text = await transcribeAndTranslate({ audioDataUrl, apiKey, targetLang });
      res.json({ text });
    } catch (error) {
      console.error('[CutOS Transcribe] Error:', error);
      res.status(500).json({ error: error?.message || 'Transcription failed' });
    }
  });

  // 字幕生成（远程媒体 → 整段字幕文本）
  router.post('/captions', async (req, res) => {
    try {
      const { mediaId, storageUrl, apiKey, language } = req.body || {};
      if (!mediaId || !storageUrl) {
        res.status(400).json({ error: 'Missing mediaId or storageUrl' });
        return;
      }

      const effectiveApiKey = apiKey || process.env.DASHSCOPE_API_KEY;
      if (!effectiveApiKey) {
        res.status(400).json({ error: 'Missing apiKey or DASHSCOPE_API_KEY' });
        return;
      }

      const { fullText, captions } = await generateCaptions({
        storageUrl,
        apiKey: effectiveApiKey,
        language,
      });
      res.json({
        mediaId,
        captions,
        fullText,
        duration: 0,
        language: language || 'zh',
      });
    } catch (error) {
      console.error('[CutOS Captions] Error:', error);
      res.status(500).json({ error: error?.message || 'Caption generation failed' });
    }
  });

  // 配音文本提取（抽取音频 → 转写并翻译为目标语言）
  router.post('/dub', async (req, res) => {
    try {
      const { sourceUrl, sourceDataUrl, apiKey, targetLanguage = 'zh' } = req.body || {};
      if (!sourceUrl && !sourceDataUrl) {
        res.status(400).json({ error: 'Missing sourceUrl or sourceDataUrl' });
        return;
      }

      const effectiveApiKey = apiKey || process.env.DASHSCOPE_API_KEY;
      if (!effectiveApiKey) {
        res.status(400).json({ error: 'Missing apiKey or DASHSCOPE_API_KEY' });
        return;
      }

      const result = await extractDubbingText({
        sourceUrl,
        sourceDataUrl,
        apiKey: effectiveApiKey,
        targetLanguage,
      });
      res.json(result);
    } catch (error) {
      console.error('[CutOS Dub] Error:', error);
      const status = error?.status || 500;
      res.status(status).json({ error: error?.message || 'Dub generation failed' });
    }
  });

  // 人声隔离（降噪 + 滤波，返回 WAV data URL）
  router.post('/isolate-voice', async (req, res) => {
    try {
      const { sourceUrl, sourceDataUrl } = req.body || {};
      if (!sourceUrl && !sourceDataUrl) {
        res.status(400).json({ error: 'Missing sourceUrl or sourceDataUrl' });
        return;
      }
      const audioDataUrl = await isolateVoiceToWavDataUrl({ sourceUrl, sourceDataUrl });
      res.json({ audioDataUrl });
    } catch (error) {
      console.error('[CutOS Isolate Voice] Error:', error);
      res.status(500).json({ error: error?.message || 'Voice isolation failed' });
    }
  });

  // Vidu 视频生成 API 代理（仅放行 /ent/v2/ 前缀）
  router.post('/vidu', async (req, res) => {
    try {
      const upstream = await proxyViduRequest(req.body);
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.contentType);
      res.send(upstream.text);
    } catch (error) {
      console.error('[CutOS Vidu Proxy] Error:', error);
      res.status(500).json({ error: error?.message || 'Vidu proxy failed' });
    }
  });

  // 浏览器时间线导出为 MP4（raw body，最大 500MB）
  router.post(
    '/export/mp4',
    express.raw({ limit: '500mb', type: () => true }),
    async (req, res) => {
      try {
        const payload = Buffer.isBuffer(req.body)
          ? req.body
          : req.body
            ? Buffer.from(req.body)
            : null;
        if (!payload || payload.length === 0) {
          res.status(400).json({ error: 'Missing export payload' });
          return;
        }

        const inputExtension = extensionFromRequestContentType(req.headers['content-type']);
        const mp4Buffer = await transcodeToMp4(payload, inputExtension);
        const exportId = crypto.randomUUID();

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(mp4Buffer.length));
        res.setHeader('Content-Disposition', `inline; filename="cutos-export-${exportId}.mp4"`);
        res.status(200).send(mp4Buffer);
      } catch (error) {
        console.error('[CutOS Export MP4] Error:', error);
        res.status(500).json({ error: error?.message || 'MP4 export failed' });
      }
    },
  );

  return router;
};
