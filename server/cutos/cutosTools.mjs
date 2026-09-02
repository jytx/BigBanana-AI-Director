/**
 * CutOS 浏览器剪辑器的 AI Agent 工具集与系统提示词
 *
 * 工具不直接操作数据，而是返回 { action, payload } 指令对象，
 * 由前端 CutOS 编辑器接收并应用到时间线。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import { z } from 'zod';
import { tool } from '@shareai-lab/kode-sdk';

/**
 * @typedef {Object} TimelineClip - 时间线片段
 * @property {string} id - 片段 ID
 * @property {string} label - 显示名称
 * @property {string} trackId - 所在轨道（V1/V2 视频，A1/A2 音频）
 * @property {number} startTimeSeconds - 起始时间（秒）
 * @property {number} durationSeconds - 时长（秒）
 * @property {number} [playbackRate] - 播放倍速
 * @property {{ preset: string }} effects - 特效配置
 */

/**
 * @typedef {Object} TimelineMedia - 媒体池素材
 * @property {string} id - 素材 ID
 * @property {string} name - 素材名称
 * @property {number} durationSeconds - 素材时长（秒）
 */

/**
 * @typedef {Object} TimelineState - 前端传入的时间线状态快照
 * @property {TimelineClip[]} clips - 时间线上的片段列表
 * @property {TimelineMedia[]} media - 媒体池素材列表
 * @property {number} currentTimeSeconds - 播放头位置（秒）
 * @property {string | null} selectedClipId - 当前选中片段 ID
 */

/**
 * 构建 CutOS 剪辑助手的系统提示词（嵌入当前时间线状态）
 * @param {TimelineState} timelineState - 时间线状态快照
 * @returns {string} 系统提示词
 */
export const buildCutosSystemPrompt = (timelineState) => {
  const clipsText = timelineState.clips.length > 0
    ? timelineState.clips.map((clip) => {
        const endTime = clip.startTimeSeconds + clip.durationSeconds;
        const speedText = clip.playbackRate && Math.abs(clip.playbackRate - 1) > 0.001
          ? `, speed: ${clip.playbackRate.toFixed(2).replace(/\.?0+$/, '')}x`
          : '';
        const effectText = clip.effects.preset !== 'none' ? `, effect: ${clip.effects.preset}` : '';
        return `- "${clip.label}" (id: ${clip.id}) on track ${clip.trackId}: `
          + `${clip.startTimeSeconds.toFixed(1)}s - ${endTime.toFixed(1)}s `
          + `(duration: ${clip.durationSeconds.toFixed(1)}s)${speedText}${effectText}`;
      }).join('\n')
    : 'No clips on timeline';

  const mediaText = timelineState.media.length > 0
    ? timelineState.media.map((item) => `- "${item.name}" (id: ${item.id}): ${item.durationSeconds.toFixed(1)}s`).join('\n')
    : 'No media files';

  const selectedText = timelineState.selectedClipId
    ? `Selected clip: ${timelineState.selectedClipId}`
    : 'No clip selected';

  return [
    'You are an AI video editing assistant for CutOS, a browser-based video editor.',
    'You help users edit their videos by manipulating clips on the timeline.',
    '',
    'CRITICAL RULES:',
    '1. Each user message is an independent request.',
    '2. You must call tools to execute actions.',
    '3. Execute each requested action only once.',
    '4. If the user asks to apply an edit, call the appropriate tool instead of replying with plain text.',
    '',
    'Current timeline state',
    '',
    'Clips on timeline:',
    clipsText,
    '',
    'Media pool:',
    mediaText,
    '',
    `Playhead position: ${timelineState.currentTimeSeconds.toFixed(1)} seconds`,
    selectedText,
    '',
    'You can:',
    '- split clips',
    '- trim clips',
    '- change clip speed',
    '- delete clips',
    '- move clips',
    '- apply effects',
    '- apply chromakey',
    '- add media to the timeline',
    '- dub clips',
    '- isolate voice',
    '- create morph transitions',
    '',
    'Guidelines:',
    '- Execute actions immediately using tools',
    '- Use seconds for all time values',
    '- Tracks: V1, V2 are video; A1, A2 are audio',
    '- For speed changes, use playbackRate between 0.5 and 1.5',
    '- Keep responses concise',
  ].join('\n');
};

/**
 * 构造前端编辑动作指令
 * @param {string} action - 动作类型（如 SPLIT_CLIP）
 * @param {Record<string, unknown>} payload - 动作参数
 * @param {string} summary - 给用户看的动作摘要
 * @returns {{ action: { action: string, payload: Record<string, unknown> }, summary: string }}
 */
const timelineAction = (action, payload, summary) => ({
  action: { action, payload },
  summary,
});

/** 构建 CutOS 时间线操作工具实例列表 */
export const buildCutosTools = () => [
  tool({
    name: 'splitClip',
    description: 'Split a specific clip into two parts at a timeline position.',
    parameters: z.object({
      clipId: z.string(),
      splitTimeSeconds: z.number(),
    }),
    execute: async (args) => timelineAction(
      'SPLIT_CLIP',
      args,
      `Split clip ${args.clipId} at ${args.splitTimeSeconds}s.`
    ),
  }),
  tool({
    name: 'splitAtTime',
    description: 'Split clips at a timeline position and optionally constrain to a track.',
    parameters: z.object({
      timeSeconds: z.number(),
      trackId: z.string().optional(),
    }),
    execute: async (args) => timelineAction('SPLIT_AT_TIME', args, `Split clips at ${args.timeSeconds}s.`),
  }),
  tool({
    name: 'trimClip',
    description: 'Trim the start or end of a clip.',
    parameters: z.object({
      clipId: z.string(),
      trimStartSeconds: z.number().optional(),
      trimEndSeconds: z.number().optional(),
    }),
    execute: async (args) => timelineAction('TRIM_CLIP', args, `Trim clip ${args.clipId}.`),
  }),
  tool({
    name: 'setClipSpeed',
    description: 'Set the playback speed of a clip. Use 0.5 to 1.5 where 1 is normal speed.',
    parameters: z.object({
      clipId: z.string(),
      playbackRate: z.number().min(0.5).max(1.5),
    }),
    execute: async (args) => timelineAction(
      'SET_CLIP_SPEED',
      args,
      `Set clip ${args.clipId} speed to ${args.playbackRate}x.`
    ),
  }),
  tool({
    name: 'deleteClip',
    description: 'Delete a specific clip from the timeline.',
    parameters: z.object({ clipId: z.string() }),
    execute: async (args) => timelineAction('DELETE_CLIP', args, `Delete clip ${args.clipId}.`),
  }),
  tool({
    name: 'deleteAtTime',
    description: 'Delete the clip at a specific timeline position.',
    parameters: z.object({
      timeSeconds: z.number(),
      trackId: z.string().optional(),
    }),
    execute: async (args) => timelineAction('DELETE_AT_TIME', args, `Delete the clip at ${args.timeSeconds}s.`),
  }),
  tool({
    name: 'deleteAllClips',
    description: 'Delete all clips from the timeline or one specific track.',
    parameters: z.object({ trackId: z.string().optional() }),
    execute: async (args) => timelineAction(
      'DELETE_ALL_CLIPS',
      args,
      args.trackId ? `Clear track ${args.trackId}.` : 'Clear all clips.'
    ),
  }),
  tool({
    name: 'moveClip',
    description: 'Move a clip to a new position or track.',
    parameters: z.object({
      clipId: z.string(),
      newStartTimeSeconds: z.number().optional(),
      newTrackId: z.string().optional(),
    }),
    execute: async (args) => timelineAction('MOVE_CLIP', args, `Move clip ${args.clipId}.`),
  }),
  tool({
    name: 'applyEffect',
    description: 'Apply a visual effect preset to a clip.',
    parameters: z.object({
      clipId: z.string(),
      effect: z.enum(['none', 'grayscale', 'sepia', 'invert', 'cyberpunk', 'noir', 'vhs', 'glitch', 'ascii']),
    }),
    execute: async (args) => timelineAction(
      'APPLY_EFFECT',
      args,
      `Apply ${args.effect} to clip ${args.clipId}.`
    ),
  }),
  tool({
    name: 'applyChromakey',
    description: 'Enable or update chromakey settings for a clip.',
    parameters: z.object({
      clipId: z.string(),
      enabled: z.boolean(),
      keyColor: z.string().optional(),
      similarity: z.number().min(0).max(1).optional(),
      smoothness: z.number().min(0).max(1).optional(),
      spill: z.number().min(0).max(1).optional(),
    }),
    execute: async (args) => timelineAction(
      'APPLY_CHROMAKEY',
      args,
      `Update chromakey on clip ${args.clipId}.`
    ),
  }),
  tool({
    name: 'addMediaToTimeline',
    description: 'Add media from the media pool to the timeline.',
    parameters: z.object({
      mediaId: z.string(),
      trackId: z.string(),
      startTimeSeconds: z.number().optional(),
    }),
    execute: async (args) => timelineAction(
      'ADD_MEDIA_TO_TIMELINE',
      args,
      `Add media ${args.mediaId} to ${args.trackId}.`
    ),
  }),
  tool({
    name: 'dubClip',
    description: 'Dub or translate the audio of a video clip to another language.',
    parameters: z.object({
      clipId: z.string(),
      targetLanguage: z.string(),
      replaceOriginal: z.boolean().optional(),
    }),
    execute: async (args) => timelineAction(
      'DUB_CLIP',
      { clipId: args.clipId, targetLanguage: args.targetLanguage, replaceOriginal: args.replaceOriginal ?? true },
      `Dub clip ${args.clipId} to ${args.targetLanguage}.`
    ),
  }),
  tool({
    name: 'createMorphTransition',
    description: 'Create an AI morph transition between two clips.',
    parameters: z.object({
      fromClipId: z.string(),
      toClipId: z.string(),
      durationSeconds: z.number().min(5).max(10).default(5),
    }),
    execute: async (args) => timelineAction(
      'CREATE_MORPH_TRANSITION',
      args,
      'Create a morph transition between two clips.'
    ),
  }),
  tool({
    name: 'isolateVoice',
    description: 'Remove background noise and isolate voice from a video clip.',
    parameters: z.object({ clipId: z.string() }),
    execute: async (args) => timelineAction(
      'ISOLATE_VOICE',
      { clipId: args.clipId, replaceOriginal: true },
      `Isolate voice on clip ${args.clipId}.`
    ),
  }),
];
