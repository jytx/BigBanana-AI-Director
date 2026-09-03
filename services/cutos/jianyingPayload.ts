/**
 * 剪映草稿导出载荷组装（纯函数层）
 *
 * 把前端时间线（片段 + 媒体池）转换为服务端
 * /api/jianying/export 可接受的 { draftInfo, media } 载荷：
 * - materials.videos/audios：素材声明（id + 微秒时长）；
 * - tracks[].segments[].source/target.timerange：微秒整数时间区间；
 * - media：每个素材一份 base64（前端读 File 得到）。
 * 结构满足服务端 jianyingExport.validateExportPayload 的全部校验。
 */

import {
  isVideoTrack,
  JianyingExportPayload,
  JianyingMediaPayload,
  TimelineClip,
  TimelineMedia,
} from './types';

/** 秒 → 微秒（服务端校验要求安全整数，取整消除浮点误差） */
const secondsToMicros = (seconds: number): number => Math.max(1, Math.round(seconds * 1_000_000));

/** File 读取为 base64（去 data URL 前缀，供服务端 decodeBase64ToBuffer 消费） */
export const readMediaFileAsBase64 = (file: File): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error(`读取媒体文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });

/** 依据轨道 ID 汇总该轨道的素材引用（轨道内素材去重） */
const collectTrackMaterialIds = (clips: TimelineClip[], trackId: string): string[] => {
  const ids: string[] = [];
  for (const clip of clips) {
    if (clip.trackId === trackId && !ids.includes(clip.mediaId)) {
      ids.push(clip.mediaId);
    }
  }
  return ids;
};

/**
 * 组装导出载荷：素材声明、轨道段、base64 媒体。
 * 视频素材进 materials.videos + 视频轨，音频素材进 materials.audios + 音频轨。
 */
export const buildJianyingExportPayload = async (
  draftName: string,
  clips: TimelineClip[],
  mediaPool: TimelineMedia[]
): Promise<JianyingExportPayload> => {
  const mediaById = new Map(mediaPool.map((media) => [media.id, media]));
  const usedMediaIds = Array.from(new Set(clips.map((clip) => clip.mediaId)));
  const usedMedia = usedMediaIds
    .map((id) => mediaById.get(id))
    .filter((media): media is TimelineMedia => media != null);

  const videoMaterials = usedMedia.filter((media) => media.kind === 'video');
  const audioMaterials = usedMedia.filter((media) => media.kind === 'audio');

  const videos = videoMaterials.map((media) => ({
    id: media.id,
    type: 'video',
    duration: secondsToMicros(media.durationSeconds),
    width: 0,
    height: 0,
  }));
  const audios = audioMaterials.map((media) => ({
    id: media.id,
    type: 'audio',
    duration: secondsToMicros(media.durationSeconds),
  }));

  const trackIds = Array.from(new Set(clips.map((clip) => clip.trackId)));
  const tracks = trackIds.map((trackId) => {
    const trackClips = clips
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    const materialId = collectTrackMaterialIds(clips, trackId)[0] || '';
    return {
      id: `track-${trackId}`,
      type: isVideoTrack(trackId) ? 'video' : 'audio',
      attribute: 0,
      flag: 0,
      segments: trackClips.map((clip) => ({
        id: `segment-${clip.id}`,
        materialId: clip.mediaId || materialId,
        sourceTimerange: {
          start: 0,
          duration: secondsToMicros(clip.durationSeconds * (clip.playbackRate ?? 1)),
        },
        targetTimerange: {
          start: secondsToMicros(clip.startTimeSeconds),
          duration: secondsToMicros(clip.durationSeconds),
        },
        extraMaterialRefs: [] as string[],
      })),
    };
  });

  const mediaPayloads: JianyingMediaPayload[] = [];
  for (const media of usedMedia) {
    const data = await readMediaFileAsBase64(media.file);
    mediaPayloads.push({
      materialId: media.id,
      kind: media.kind,
      data,
      fileName: media.fileName,
      mimeType: media.file.type || undefined,
    });
  }

  return {
    draftName,
    draftInfo: {
      materials: { videos, audios },
      tracks,
    },
    media: mediaPayloads,
  };
};
