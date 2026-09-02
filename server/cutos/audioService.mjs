/**
 * 音视频处理与 DashScope 语音服务
 *
 * 基于 ffmpeg-static 执行音频抽取 / 人声隔离 / MP4 转码，
 * 并调用阿里云百炼（DashScope）qwen3-livetranslate-flash
 * 完成语音转写、字幕生成与配音翻译。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {
  encodeBufferToDataUrl,
  extensionFromContentType,
  extensionFromUrl,
  parseDataUrl,
} from './httpHelpers.mjs';

/** DashScope OpenAI 兼容模式端点 */
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 语音转写/翻译模型 */
const LIVE_TRANSLATE_MODEL = 'qwen3-livetranslate-flash';

/**
 * 获取源媒体内容（data URL 优先，其次远程 URL）
 * @param {{ sourceUrl?: string, sourceDataUrl?: string }} source - 媒体来源
 * @returns {Promise<{ buffer: Buffer, contentType: string, extension: string }>}
 * @throws {Error} 缺少来源或下载失败时抛出
 */
export const fetchSourceMedia = async (source) => {
  const dataUrl = typeof source?.sourceDataUrl === 'string' ? source.sourceDataUrl.trim() : '';
  if (dataUrl) {
    return parseDataUrl(dataUrl);
  }

  const sourceUrl = typeof source?.sourceUrl === 'string' ? source.sourceUrl.trim() : '';
  if (!sourceUrl) {
    throw new Error('Missing sourceUrl or sourceDataUrl');
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Unable to fetch source media: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
    extension: extensionFromContentType(contentType) || extensionFromUrl(sourceUrl) || 'mp4',
  };
};

/**
 * 执行一次 ffmpeg 转换：临时目录落盘 → spawn → 读取产物 → 清理
 * @param {object} options
 * @param {Buffer} options.inputBuffer - 输入内容
 * @param {string} options.inputExtension - 输入扩展名
 * @param {string} options.outputExtension - 输出扩展名
 * @param {(paths: { inputPath: string, outputPath: string }) => string[]} options.buildArgs - ffmpeg 参数构造器
 * @returns {Promise<Buffer>} 转换产物
 * @throws {Error} ffmpeg 不可用或执行失败时抛出（附带 stderr 摘要）
 */
export const runFfmpeg = async ({ inputBuffer, inputExtension, outputExtension, buildArgs }) => {
  const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!ffmpegPath) {
    throw new Error('FFmpeg is unavailable on the server.');
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cutos-audio-'));
  const inputPath = path.join(workDir, `input.${inputExtension || 'mp4'}`);
  const outputPath = path.join(workDir, `output.${outputExtension}`);

  try {
    await fs.promises.writeFile(inputPath, inputBuffer);

    const args = buildArgs({ inputPath, outputPath });
    /** @type {Buffer[]} */
    const stderrChunks = [];

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(undefined);
          return;
        }
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(stderrText || `FFmpeg exited with code ${code}`));
      });
    });

    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * 抽取音频为 16kHz 单声道 WAV（转写前置处理）
 * @param {{ sourceUrl?: string, sourceDataUrl?: string }} source - 媒体来源
 * @returns {Promise<string>} audio/wav 的 data URL
 */
export const extractMonoWavDataUrl = async (source) => {
  const media = await fetchSourceMedia(source);
  const wavBuffer = await runFfmpeg({
    inputBuffer: media.buffer,
    inputExtension: media.extension,
    outputExtension: 'wav',
    buildArgs: ({ inputPath, outputPath }) => [
      '-y', '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      outputPath,
    ],
  });
  return encodeBufferToDataUrl(wavBuffer, 'audio/wav');
};

/**
 * 人声隔离：高通/低通滤波 + FFT 降噪 + 增益
 * @param {{ sourceUrl?: string, sourceDataUrl?: string }} source - 媒体来源
 * @returns {Promise<string>} audio/wav 的 data URL
 */
export const isolateVoiceToWavDataUrl = async (source) => {
  const media = await fetchSourceMedia(source);
  const wavBuffer = await runFfmpeg({
    inputBuffer: media.buffer,
    inputExtension: media.extension,
    outputExtension: 'wav',
    buildArgs: ({ inputPath, outputPath }) => [
      '-y', '-i', inputPath,
      '-vn',
      '-af', 'highpass=f=120,lowpass=f=8000,afftdn=nf=-25,volume=1.8',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      outputPath,
    ],
  });
  return encodeBufferToDataUrl(wavBuffer, 'audio/wav');
};

/**
 * 将浏览器录制格式（webm/mp4 等）转码为 H.264/AAC 的 MP4
 * @param {Buffer} inputBuffer - 输入内容
 * @param {string} inputExtension - 输入扩展名
 * @returns {Promise<Buffer>} MP4 产物
 */
export const transcodeToMp4 = (inputBuffer, inputExtension) => runFfmpeg({
  inputBuffer,
  inputExtension,
  outputExtension: 'mp4',
  buildArgs: ({ inputPath, outputPath }) => [
    '-y', '-i', inputPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    outputPath,
  ],
});

/**
 * 从 SSE 流式响应中拼接增量文本（choices[0].delta.content）
 * @param {Response} response - fetch 响应（SSE 流）
 * @returns {Promise<string>} 拼接后的完整文本
 */
const readSseContent = async (response) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Unable to read streamed response body');
  }

  const decoder = new TextDecoder();
  let content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    const dataLines = decoder
      .decode(value, { stream: true })
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]');

    for (const line of dataLines) {
      try {
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
          content += delta;
        }
      } catch {
        // 忽略无法解析的分片
      }
    }
  }
  return content.trim();
};

/**
 * 调用 DashScope 实时翻译模型：语音转写并翻译为目标语言（流式）
 * @param {object} options
 * @param {string} options.audioDataUrl - 音频 data URL
 * @param {string} options.apiKey - DashScope API 密钥
 * @param {string} [options.targetLang] - 目标语言，默认 zh
 * @returns {Promise<string>} 转写/翻译文本
 * @throws {Error} 上游非 2xx 时抛出（附带响应片段）
 */
export const transcribeAndTranslate = async ({ audioDataUrl, apiKey, targetLang = 'zh' }) => {
  if (!audioDataUrl || !apiKey) {
    throw new Error('Missing audioDataUrl or apiKey');
  }

  const formatMatch = String(audioDataUrl).match(/^data:audio\/([\w.+-]+);base64,/i);
  const audioFormat = formatMatch ? formatMatch[1] : 'wav';

  const response = await fetch(`${DASHSCOPE_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LIVE_TRANSLATE_MODEL,
      messages: [{
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: audioDataUrl, format: audioFormat },
        }],
      }],
      modalities: ['text'],
      stream: true,
      stream_options: { include_usage: true },
      translation_options: { target_lang: targetLang },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText?.slice(0, 500) || `HTTP ${response.status}`);
  }
  return readSseContent(response);
};

/**
 * 生成媒体字幕：下载远程媒体 → 编码 base64 → 调用实时翻译模型（非流式）
 * @param {object} options
 * @param {string} options.storageUrl - 媒体远程地址
 * @param {string} options.apiKey - DashScope API 密钥（可选，回退环境变量由调用方处理）
 * @param {string} [options.language] - 目标语言，默认 zh
 * @returns {Promise<{ fullText: string, captions: Array<{ word: string, start: number, end: number }> }>}
 * @throws {Error} 下载失败或上游非 2xx 时抛出
 */
export const generateCaptions = async ({ storageUrl, apiKey, language = 'zh' }) => {
  const mediaResponse = await fetch(storageUrl);
  if (!mediaResponse.ok) {
    throw new Error('Unable to fetch media file');
  }

  const base64 = Buffer.from(await (await mediaResponse.blob()).arrayBuffer()).toString('base64');
  const contentType = mediaResponse.headers.get('content-type') || '';
  const format = contentType.includes('webm') ? 'webm' : contentType.includes('mp3') ? 'mp3' : 'mp4';

  const response = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LIVE_TRANSLATE_MODEL,
      messages: [{
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: `data:audio/${format};base64,${base64}`, format },
        }],
      }],
      modalities: ['text'],
      stream: false,
      translation_options: { target_lang: language || 'zh' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText?.slice(0, 500) || 'Caption generation failed');
  }

  const fullText = (await response.json()).choices?.[0]?.message?.content?.trim() || '';
  const captions = fullText ? [{ word: fullText, start: 0, end: 10 }] : [];
  return { fullText, captions };
};

/**
 * 配音前置：抽取单声道 WAV 后转写/翻译为目标语言文本
 * @param {object} options
 * @param {string} [options.sourceUrl] - 媒体远程地址
 * @param {string} [options.sourceDataUrl] - 媒体 data URL
 * @param {string} options.apiKey - DashScope API 密钥
 * @param {string} [options.targetLanguage] - 目标语言，默认 zh
 * @returns {Promise<{ text: string, targetLanguage: string }>}
 * @throws {Error} 未检出语音内容时抛出 422 语义错误
 */
export const extractDubbingText = async ({ sourceUrl, sourceDataUrl, apiKey, targetLanguage = 'zh' }) => {
  const wavDataUrl = await extractMonoWavDataUrl({ sourceUrl, sourceDataUrl });
  const text = await transcribeAndTranslate({
    audioDataUrl: wavDataUrl,
    apiKey,
    targetLang: targetLanguage || 'zh',
  });

  if (!String(text || '').trim()) {
    const error = new Error('No spoken content detected for dubbing');
    error.status = 422;
    throw error;
  }

  return { text: String(text).trim(), targetLanguage: targetLanguage || 'zh' };
};
