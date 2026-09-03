/**
 * CutOS 剪辑工作台协议类型
 *
 * 对齐已恢复的服务端（server/cutos/）：
 * - /api/cutos/agent/stream 的请求体与 NDJSON 事件
 * - /api/jianying 的能力探测与草稿导出载荷
 * - 14 个时间线操作指令（cutosTools.mjs 的 action 常量）
 */

/** 轨道 ID：V1/V2 为视频轨，A1/A2 为音频轨 */
export type TrackId = 'V1' | 'V2' | 'A1' | 'A2';

/** 全部轨道（自下而上渲染顺序） */
export const ALL_TRACKS: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

/** 视频轨集合判断 */
export const isVideoTrack = (trackId: string): boolean => trackId.startsWith('V');

/** 特效预设（与服务端 applyEffect 工具枚举一致） */
export type EffectPreset = 'none' | 'grayscale' | 'sepia' | 'invert' | 'cyberpunk' | 'noir' | 'vhs' | 'glitch' | 'ascii';

/** 绿幕（色度键）配置 */
export interface ChromakeyConfig {
  enabled: boolean;
  keyColor?: string;
  similarity?: number;
  smoothness?: number;
  spill?: number;
}

/** 媒体池素材（前端本地持有源文件；服务端只读 id/name/durationSeconds） */
export interface TimelineMedia {
  id: string;
  name: string;
  durationSeconds: number;
  kind: 'video' | 'audio';
  /** 本地源地址（objectURL），导出与预览用 */
  sourceUrl: string;
  fileName: string;
  /** 原始 File 引用（导出时读 base64） */
  file: File;
}

/** 时间线片段（服务端系统提示词读取 label/trackId/时间/倍速/特效） */
export interface TimelineClip {
  id: string;
  label: string;
  trackId: TrackId;
  startTimeSeconds: number;
  durationSeconds: number;
  playbackRate?: number;
  effects: { preset: EffectPreset };
  chromakey?: ChromakeyConfig;
  /** 关联的媒体池素材 id（前端导出用） */
  mediaId: string;
  /** AI 后处理标记（配音目标语言），由 DUB_CLIP 指令写入 */
  dubLanguage?: string;
  /** 人声隔离标记，由 ISOLATE_VOICE 指令写入 */
  voiceIsolated?: boolean;
  /** AI 变形转场标记（指向下一片段），由 CREATE_MORPH_TRANSITION 指令写入 */
  morphTransition?: { toClipId: string; durationSeconds: number };
}

/** 传给服务端的时间线状态快照 */
export interface TimelineStateSnapshot {
  clips: Array<Pick<TimelineClip, 'id' | 'label' | 'trackId' | 'startTimeSeconds' | 'durationSeconds' | 'playbackRate' | 'effects'>>;
  media: Array<Pick<TimelineMedia, 'id' | 'name' | 'durationSeconds'>>;
  currentTimeSeconds: number;
  selectedClipId: string | null;
}

/** 服务端要求的模型配置（BYOK） */
export interface CutosModelConfig {
  apiKey: string;
  model: string;
  apiBase?: string;
}

/** 剪辑 Agent 流式请求体 */
export interface CutosAgentRequest {
  input: string;
  modelConfig: CutosModelConfig;
  timelineState: TimelineStateSnapshot;
  agentId: string;
}

/** Agent 返回的时间线操作指令（工具 result 的结构） */
export interface TimelineCommand {
  action: string;
  payload: Record<string, unknown>;
}

/** 工具调用明细（result.toolCalls 元素） */
export interface CutosToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  error: string | undefined;
  status: 'success' | 'error';
  state: string;
  durationMs: number | undefined;
}

/** Agent 最终结果 */
export interface CutosAgentResult {
  agentId: string;
  text: string;
  toolCalls: CutosToolCall[];
  events: unknown[];
}

/** NDJSON 流事件（服务端 writeNdjsonLine 的四种 type） */
export type CutosStreamMessage =
  | { type: 'text-delta'; delta: string; text: string }
  | { type: 'event'; event: CutosStreamEvent }
  | { type: 'result'; result: CutosAgentResult }
  | { type: 'error'; error: string };

/** 流式结构化事件（agentRuntime.mapStreamEvent 的简化事件） */
export interface CutosStreamEvent {
  id: string;
  step?: number;
  type: 'text' | 'tool:start' | 'tool:end' | 'tool:error' | 'done';
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  error?: string;
  state?: string;
  durationMs?: number;
  reason?: string;
}

/** 剪映草稿能力探测结果 */
export interface JianyingCapabilities {
  available: boolean;
  draftRoot?: string;
  platform?: string;
  reason?: string;
}

/** 剪映导出载荷中的媒体项（base64 内联） */
export interface JianyingMediaPayload {
  materialId: string;
  kind: 'video' | 'audio';
  data: string;
  fileName?: string;
  mimeType?: string;
}

/** 剪映导出载荷（服务端 jianyingExport.validateExportPayload 的结构） */
export interface JianyingExportPayload {
  draftName: string;
  draftInfo: {
    materials: {
      videos: Array<Record<string, unknown>>;
      audios: Array<Record<string, unknown>>;
    };
    tracks: Array<Record<string, unknown>>;
  };
  media: JianyingMediaPayload[];
}

/** 剪映导出响应 */
export interface JianyingExportResponse {
  draftName?: string;
  draftRoot?: string;
  estimatedBytes?: number;
  error?: string;
}
