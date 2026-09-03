/**
 * AI 变形转场生成
 *
 * 移植官方 studio 版 morph-transition 模块的核心链路：
 * canvas 截取「前片段尾帧 / 后片段首帧」（JPEG 0.85）→
 * 调用旧版视频服务 generateVideo 双图生视频（单图走 sora-2，双图走 veo）。
 */

import { generateVideo } from '../ai/videoService';

/** 官方转场提示词（反混淆产物原文） */
export const MORPH_TRANSITION_PROMPT = '平滑过渡转场，保持画面连贯自然';

/** 视频源在指定时间点截帧（官方 b 函数：seek → canvas → JPEG 0.85） */
export const extractFrameAtSecond = (videoUrl: string, timeSeconds: number): Promise<Blob> =>
  new Promise<Blob>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => {
      if (video.src.startsWith('blob:')) {
        URL.revokeObjectURL(video.src);
      }
    };
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(Math.max(0, timeSeconds), video.duration);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (context == null) {
          reject(new Error('无法创建画布上下文'));
          cleanup();
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob != null) {
            resolve(blob);
          } else {
            reject(new Error('画布导出帧失败'));
          }
          cleanup();
        }, 'image/jpeg', 0.85);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        cleanup();
      }
    };
    video.onerror = () => {
      reject(new Error(`视频加载失败：${videoUrl}`));
      cleanup();
    };
    video.src = videoUrl;
  });

/** 前片段尾帧（官方 F 函数：duration - 0.1s） */
export const extractTailFrame = async (videoUrl: string, durationSeconds: number): Promise<Blob> =>
  extractFrameAtSecond(videoUrl, Math.max(0, durationSeconds - 0.1));

/** 后片段首帧（官方 T 函数：0.1s） */
export const extractHeadFrame = (videoUrl: string): Promise<Blob> => extractFrameAtSecond(videoUrl, 0.1);

/** Blob → 纯 base64（去 data URL 前缀） */
export const blobToRawBase64 = async (blob: Blob): Promise<string> => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('帧图读取失败'));
    reader.readAsDataURL(blob);
  });
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
};

/** 旧版视频服务支持的时长档位（变形转场取 5-10s 钳制到最近档位） */
const MORPH_DURATION_OPTIONS: ReadonlyArray<{ value: number }> = [{ value: 5 }, { value: 8 }, { value: 10 }];

/** 钳制到视频服务支持的时长档位 */
const clampToSupportedDuration = (durationSeconds: number): 5 | 8 | 10 => {
  const nearest = MORPH_DURATION_OPTIONS.reduce((best, option) =>
    Math.abs(option.value - durationSeconds) < Math.abs(best - durationSeconds) ? option.value : best, 5);
  return nearest as 5 | 8 | 10;
};

/**
 * 生成变形转场：取前片段尾帧为起始图、后片段首帧为结束图，
 * 双图调用视频服务生成转场片段，返回结果视频 URL。
 */
export const generateMorphTransition = async (input: {
  fromVideoUrl: string;
  fromDurationSeconds: number;
  toVideoUrl: string;
  durationSeconds: number;
}): Promise<string> => {
  const startBlob = await extractTailFrame(input.fromVideoUrl, input.fromDurationSeconds);
  const endBlob = await extractHeadFrame(input.toVideoUrl);
  const startImageBase64 = await blobToRawBase64(startBlob);
  const endImageBase64 = await blobToRawBase64(endBlob);
  return generateVideo(
    MORPH_TRANSITION_PROMPT,
    startImageBase64,
    endImageBase64,
    'sora-2',
    '16:9',
    clampToSupportedDuration(input.durationSeconds)
  );
};

/** 远程视频 URL 下载结果：文件与本地预览地址 */
export interface DownloadedVideo {
  file: File;
  sourceUrl: string;
  durationSeconds: number;
}

/** 远程视频 URL 下载为本地媒体（生成结果入媒体池用） */
export const fetchVideoUrlAsMedia = async (videoUrl: string, fileName: string): Promise<DownloadedVideo> => {
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`转场结果下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const sourceUrl = URL.createObjectURL(blob);
  const durationSeconds = await new Promise<number>((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
    probe.onerror = () => resolve(0);
    probe.src = sourceUrl;
  });
  return {
    file: new File([blob], fileName, { type: blob.type || 'video/mp4' }),
    sourceUrl,
    durationSeconds,
  };
};
