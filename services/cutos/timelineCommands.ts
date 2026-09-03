/**
 * 时间线指令应用器（纯函数层）
 * 服务端剪辑工具不直接操作数据，而是返回 { action, payload } 指令
 * （见 server/cutos/cutosTools.mjs）；本模块在本地时间线状态上逐条执行。
 */

import { EffectPreset, TimelineClip, TrackId } from './types';

/** 指令应用结果：新状态 + 是否命中 + 摘要 */
export interface CommandApplyOutcome {
  clips: TimelineClip[];
  applied: boolean;
  summary: string;
}

/** 从工具 result 中提取指令（非法结构返回 null） */
export const extractTimelineCommand = (result: unknown): { action: string; payload: Record<string, unknown> } | null => {
  const command = (result as { action?: unknown } | null | undefined)?.action;
  if (typeof command !== 'object' || command == null) {
    return null;
  }
  const action = (command as { action?: unknown }).action;
  const payload = (command as { payload?: unknown }).payload;
  if (typeof action !== 'string') {
    return null;
  }
  return { action, payload: (typeof payload === 'object' && payload != null ? payload : {}) as Record<string, unknown> };
};

/** 数值读取（缺省回退） */
const readNumber = (payload: Record<string, unknown>, key: string): number | undefined => {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** 字符串读取（缺省回退） */
const readString = (payload: Record<string, unknown>, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** 在时间点切分单个片段（切点在边界外时返回原片段） */
const splitOneClip = (clip: TimelineClip, splitTimeSeconds: number): TimelineClip[] => {
  const relative = splitTimeSeconds - clip.startTimeSeconds;
  if (relative <= 0.01 || relative >= clip.durationSeconds - 0.01) {
    return [clip];
  }
  return [
    { ...clip, id: `${clip.id}a`, durationSeconds: relative },
    {
      ...clip,
      id: `${clip.id}b`,
      startTimeSeconds: clip.startTimeSeconds + relative,
      durationSeconds: clip.durationSeconds - relative,
    },
  ];
};

/** 应用单条指令到片段列表（未匹配时原样返回） */
export const applyTimelineCommand = (
  clips: TimelineClip[],
  mediaDurationsById: Map<string, number>,
  action: string,
  payload: Record<string, unknown>
): CommandApplyOutcome => {
  const clipId = readString(payload, 'clipId');
  const findByClipId = (list: TimelineClip[]): TimelineClip | undefined =>
    clipId == null ? undefined : list.find((clip) => clip.id === clipId);

  if (action === 'SPLIT_CLIP') {
    const splitTime = readNumber(payload, 'splitTimeSeconds');
    const target = findByClipId(clips);
    if (target == null || splitTime == null) {
      return { clips, applied: false, summary: `未找到片段 ${clipId ?? ''} 或切点无效` };
    }
    return {
      clips: clips.flatMap((clip) => (clip.id === target.id ? splitOneClip(clip, splitTime) : [clip])),
      applied: true,
      summary: `已在 ${splitTime}s 处切分「${target.label}」`,
    };
  }

  if (action === 'SPLIT_AT_TIME') {
    const splitTime = readNumber(payload, 'timeSeconds');
    const trackId = readString(payload, 'trackId');
    if (splitTime == null) {
      return { clips, applied: false, summary: '切点无效' };
    }
    const inRange = (clip: TimelineClip): boolean =>
      (trackId == null || clip.trackId === trackId)
      && splitTime > clip.startTimeSeconds + 0.01
      && splitTime < clip.startTimeSeconds + clip.durationSeconds - 0.01;
    let touched = false;
    const next = clips.flatMap((clip) => {
      if (!inRange(clip)) {
        return [clip];
      }
      touched = true;
      return splitOneClip(clip, splitTime);
    });
    return { clips: next, applied: touched, summary: touched ? `已在 ${splitTime}s 处切分跨越的片段` : '该时间点没有需要切分的片段' };
  }

  if (action === 'TRIM_CLIP') {
    const trimStart = readNumber(payload, 'trimStartSeconds') ?? 0;
    const trimEnd = readNumber(payload, 'trimEndSeconds') ?? 0;
    const target = findByClipId(clips);
    if (target == null || trimStart + trimEnd <= 0 || trimStart + trimEnd >= target.durationSeconds) {
      return { clips, applied: false, summary: `片段 ${clipId ?? ''} 无法按给定参数修剪` };
    }
    return {
      clips: clips.map((clip) => (clip.id === target.id
        ? {
            ...clip,
            startTimeSeconds: clip.startTimeSeconds + trimStart,
            durationSeconds: clip.durationSeconds - trimStart - trimEnd,
          }
        : clip)),
      applied: true,
      summary: `已修剪「${target.label}」（掐头 ${trimStart}s / 去尾 ${trimEnd}s）`,
    };
  }

  if (action === 'SET_CLIP_SPEED') {
    const playbackRate = readNumber(payload, 'playbackRate');
    const target = findByClipId(clips);
    if (target == null || playbackRate == null || playbackRate < 0.5 || playbackRate > 1.5) {
      return { clips, applied: false, summary: `片段 ${clipId ?? ''} 倍速参数无效（0.5-1.5）` };
    }
    const oldRate = target.playbackRate ?? 1;
    return {
      clips: clips.map((clip) => (clip.id === target.id
        ? { ...clip, playbackRate, durationSeconds: (clip.durationSeconds * oldRate) / playbackRate }
        : clip)),
      applied: true,
      summary: `已将「${target.label}」倍速设为 ${playbackRate}x`,
    };
  }

  if (action === 'DELETE_CLIP') {
    const target = findByClipId(clips);
    if (target == null) {
      return { clips, applied: false, summary: `未找到片段 ${clipId ?? ''}` };
    }
    return { clips: clips.filter((clip) => clip.id !== target.id), applied: true, summary: `已删除「${target.label}」` };
  }

  if (action === 'DELETE_AT_TIME') {
    const timeSeconds = readNumber(payload, 'timeSeconds');
    const trackId = readString(payload, 'trackId');
    if (timeSeconds == null) {
      return { clips, applied: false, summary: '删除时间点无效' };
    }
    const victims = clips.filter(
      (clip) => (trackId == null || clip.trackId === trackId)
        && timeSeconds >= clip.startTimeSeconds
        && timeSeconds < clip.startTimeSeconds + clip.durationSeconds
    );
    if (victims.length === 0) {
      return { clips, applied: false, summary: `${timeSeconds}s 处没有片段` };
    }
    const victimIds = new Set(victims.map((clip) => clip.id));
    return {
      clips: clips.filter((clip) => !victimIds.has(clip.id)),
      applied: true,
      summary: `已删除 ${timeSeconds}s 处的 ${victims.length} 个片段`,
    };
  }

  if (action === 'DELETE_ALL_CLIPS') {
    const trackId = readString(payload, 'trackId');
    const remaining = clips.filter((clip) => trackId != null && clip.trackId !== trackId);
    return {
      clips: trackId == null ? [] : remaining,
      applied: true,
      summary: trackId == null ? '已清空全部片段' : `已清空轨道 ${trackId}`,
    };
  }

  if (action === 'MOVE_CLIP') {
    const newStart = readNumber(payload, 'newStartTimeSeconds');
    const newTrackId = readString(payload, 'newTrackId') as TrackId | undefined;
    const target = findByClipId(clips);
    if (target == null || (newStart == null && newTrackId == null)) {
      return { clips, applied: false, summary: `片段 ${clipId ?? ''} 移动参数无效` };
    }
    return {
      clips: clips.map((clip) =>
        clip.id === target.id
          ? {
              ...clip,
              startTimeSeconds: newStart ?? clip.startTimeSeconds,
              trackId: newTrackId ?? clip.trackId,
            }
          : clip
      ),
      applied: true,
      summary: `已移动「${target.label}」${newTrackId != null ? `到轨道 ${newTrackId}` : ''}${newStart != null ? `至 ${newStart}s` : ''}`,
    };
  }

  if (action === 'APPLY_EFFECT') {
    const effect = readString(payload, 'effect') as EffectPreset | undefined;
    const target = findByClipId(clips);
    if (target == null || effect == null) {
      return { clips, applied: false, summary: `片段 ${clipId ?? ''} 特效参数无效` };
    }
    return {
      clips: clips.map((clip) => (clip.id === target.id ? { ...clip, effects: { preset: effect } } : clip)),
      applied: true,
      summary: `已为「${target.label}」应用特效 ${effect}`,
    };
  }

  if (action === 'APPLY_CHROMAKEY') {
    const enabled = payload.enabled === true;
    const target = findByClipId(clips);
    if (target == null) {
      return { clips, applied: false, summary: `未找到片段 ${clipId ?? ''}` };
    }
    const chromakey = {
      enabled,
      keyColor: readString(payload, 'keyColor'),
      similarity: readNumber(payload, 'similarity'),
      smoothness: readNumber(payload, 'smoothness'),
      spill: readNumber(payload, 'spill'),
    };
    return {
      clips: clips.map((clip) => (clip.id === target.id ? { ...clip, chromakey } : clip)),
      applied: true,
      summary: `已${enabled ? '开启' : '关闭'}「${target.label}」的绿幕抠像`,
    };
  }

  if (action === 'ADD_MEDIA_TO_TIMELINE') {
    const mediaId = readString(payload, 'mediaId');
    const trackId = readString(payload, 'trackId') as TrackId | undefined;
    const duration = mediaId != null ? mediaDurationsById.get(mediaId) : undefined;
    if (mediaId == null || trackId == null || duration == null) {
      return { clips, applied: false, summary: '素材不存在或轨道无效' };
    }
    const trackClips = clips.filter((clip) => clip.trackId === trackId);
    const trackEnd = trackClips.reduce((maxEnd, clip) => Math.max(maxEnd, clip.startTimeSeconds + clip.durationSeconds), 0);
    const startTime = readNumber(payload, 'startTimeSeconds') ?? trackEnd;
    const newClip: TimelineClip = {
      id: `clip-${mediaId}-${trackClips.length + 1}-${Math.round(startTime * 10)}`,
      label: mediaId,
      trackId,
      startTimeSeconds: startTime,
      durationSeconds: duration,
      effects: { preset: 'none' },
      mediaId,
    };
    return { clips: [...clips, newClip], applied: true, summary: `已将素材 ${mediaId} 加入轨道 ${trackId}` };
  }

  if (action === 'DUB_CLIP') {
    const targetLanguage = readString(payload, 'targetLanguage');
    const target = findByClipId(clips);
    if (target == null || targetLanguage == null) {
      return { clips, applied: false, summary: `片段 ${clipId ?? ''} 配音参数无效` };
    }
    return {
      clips: clips.map((clip) => (clip.id === target.id ? { ...clip, dubLanguage: targetLanguage } : clip)),
      applied: true,
      summary: `已标记「${target.label}」配音为${targetLanguage}`,
    };
  }

  if (action === 'CREATE_MORPH_TRANSITION') {
    const fromClipId = readString(payload, 'fromClipId');
    const toClipId = readString(payload, 'toClipId');
    const durationSeconds = readNumber(payload, 'durationSeconds') ?? 5;
    const from = clips.find((clip) => clip.id === fromClipId);
    if (fromClipId == null || toClipId == null || from == null) {
      return { clips, applied: false, summary: '变形转场的起始片段不存在' };
    }
    return {
      clips: clips.map((clip) =>
        clip.id === fromClipId ? { ...clip, morphTransition: { toClipId, durationSeconds } } : clip
      ),
      applied: true,
      summary: `已标记「${from.label}」→ ${toClipId} 的 AI 变形转场（${durationSeconds}s）`,
    };
  }

  if (action === 'ISOLATE_VOICE') {
    const target = findByClipId(clips);
    if (target == null) {
      return { clips, applied: false, summary: `未找到片段 ${clipId ?? ''}` };
    }
    return {
      clips: clips.map((clip) => (clip.id === target.id ? { ...clip, voiceIsolated: true } : clip)),
      applied: true,
      summary: `已标记「${target.label}」执行人声隔离`,
    };
  }

  return { clips, applied: false, summary: `暂不支持的指令：${action}` };
};
