/**
 * CutOS 服务端 API 客户端
 *
 * 封装 /api/cutos/agent/stream（NDJSON 流式对话）与
 * /api/jianying（能力探测 + 草稿导出）两组接口。
 */

import { consumeNdjsonStream } from './ndjsonStream';
import { checkApiKey, getApiBase, resolveRequestModel, getActiveChatModel } from '../ai/apiCore';
import {
  CutosAgentRequest,
  CutosModelConfig,
  CutosStreamMessage,
  JianyingCapabilities,
  JianyingExportPayload,
  JianyingExportResponse,
  TimelineClip,
  TimelineMedia,
  TimelineStateSnapshot,
} from './types';

/** 组装传给服务端的时间线快照（仅保留服务端系统提示词读取的字段） */
export const buildTimelineSnapshot = (
  clips: TimelineClip[],
  mediaPool: TimelineMedia[],
  currentTimeSeconds: number,
  selectedClipId: string | null
): TimelineStateSnapshot => ({
  clips: clips.map((clip) => ({
    id: clip.id,
    label: clip.label,
    trackId: clip.trackId,
    startTimeSeconds: clip.startTimeSeconds,
    durationSeconds: clip.durationSeconds,
    playbackRate: clip.playbackRate,
    effects: clip.effects,
  })),
  media: mediaPool.map((media) => ({
    id: media.id,
    name: media.name,
    durationSeconds: media.durationSeconds,
  })),
  currentTimeSeconds,
  selectedClipId,
});

/** 组装 BYOK 模型配置（当前激活的 chat 模型 + 网关地址；未配置时抛错） */
export const resolveCutosModelConfig = (): CutosModelConfig => {
  const activeModel = getActiveChatModel();
  return {
    apiKey: checkApiKey('chat', activeModel?.id),
    model: resolveRequestModel('chat', activeModel?.id),
    apiBase: getApiBase('chat'),
  };
};

/** 解析单条流消息（非法结构跳过） */
export const parseStreamMessage = (message: unknown): CutosStreamMessage | null => {
  if (typeof message !== 'object' || message == null) {
    return null;
  }
  const type = (message as { type?: unknown }).type;
  if (type === 'text-delta' || type === 'event' || type === 'result' || type === 'error') {
    return message as CutosStreamMessage;
  }
  return null;
};

/**
 * 剪辑 Agent 流式对话：POST /api/cutos/agent/stream
 * 每条 NDJSON 消息回调一次；HTTP 非 2xx 时抛出服务端错误。
 */
export const streamCutosAgent = async (
  request: CutosAgentRequest,
  onMessage: (message: CutosStreamMessage) => void,
  abortSignal: AbortSignal | undefined
): Promise<void> => {
  const response = await fetch('/api/cutos/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: abortSignal,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      detail = String((errorBody as { error?: unknown }).error || detail);
    } catch {
      // keep default detail
    }
    throw new Error(detail);
  }
  await consumeNdjsonStream(response, (raw) => {
    const parsed = parseStreamMessage(raw);
    if (parsed != null) {
      onMessage(parsed);
    }
  });
};

/** 剪映草稿目录能力探测：GET /api/jianying/capabilities */
export const fetchJianyingCapabilities = async (
  abortSignal: AbortSignal | undefined
): Promise<JianyingCapabilities> => {
  const response = await fetch('/api/jianying/capabilities', { signal: abortSignal });
  const body = await response.json();
  return body as JianyingCapabilities;
};

/** 剪映草稿导出：POST /api/jianying/export（媒体 base64 内联，载荷较大） */
export const exportJianyingDraft = async (
  payload: JianyingExportPayload,
  abortSignal: AbortSignal | undefined
): Promise<JianyingExportResponse> => {
  const response = await fetch('/api/jianying/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: abortSignal,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(String((body as { error?: unknown }).error || `HTTP ${response.status}`));
  }
  return body as JianyingExportResponse;
};
