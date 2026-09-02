/**
 * 剪映（JianYing / CapCut）草稿目录探测与文件名工具
 *
 * 负责在各平台常见安装路径中定位可写的草稿根目录，
 * 并提供导出所需的文件名清洗 / 扩展名推断能力。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 导出 payload 中允许的最大媒体文件数 */
export const MAX_MEDIA_COUNT = Number.parseInt(process.env.JIANYING_MAX_MEDIA_COUNT || '500', 10);

/** 导出 payload 中允许的最大媒体总字节数（默认 2GB） */
export const MAX_MEDIA_BYTES = Number.parseInt(
  process.env.JIANYING_MAX_MEDIA_BYTES || String(2147483648),
  10,
);

/** 剪映可稳定兼容的目标版本（更高版本草稿格式变更，不保证可读） */
export const RECOMMENDED_VERSION = '5.9 or earlier';

/**
 * 显式配置的草稿根目录（JIANYING_DRAFT_ROOT 优先，兼容旧变量名）
 * @returns {string} 配置值（可能为空串）
 */
const getExplicitDraftRoot = () => String(
  process.env.JIANYING_DRAFT_ROOT || process.env.JIANYING_PROJECTS_ROOT || ''
).trim();

/**
 * 组装各平台的候选草稿根目录列表（按优先级排序，已去重）
 * @param {NodeJS.ProcessEnv} [env] - 环境变量（默认 process.env）
 * @param {NodeJS.Platform} [platform] - 平台（默认 process.platform）
 * @returns {string[]} 候选目录绝对路径列表
 */
export const buildDraftRootCandidates = (env = process.env, platform = process.platform) => {
  const explicit = String(env.JIANYING_DRAFT_ROOT || env.JIANYING_PROJECTS_ROOT || '').trim();
  /** @type {string[]} */
  const candidates = [];
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }

  const home = env.USERPROFILE || env.HOME || os.homedir();
  const localAppData = env.LOCALAPPDATA || (platform === 'win32' ? path.join(home, 'AppData', 'Local') : '');

  if (platform === 'win32') {
    if (localAppData) {
      candidates.push(path.join(localAppData, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
      candidates.push(path.join(localAppData, 'Jianying', 'User Data', 'Projects', 'com.lveditor.draft'));
      candidates.push(path.join(localAppData, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
    }
    candidates.push(path.join(home, 'Movies', 'JianyingPro Drafts'));
  } else {
    candidates.push(path.join(home, 'Movies', 'JianyingPro Drafts'));
    candidates.push(path.join(home, 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
    candidates.push(path.join(home, 'Library', 'Application Support', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
  }

  return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
};

/** 判断目录存在 */
const isDirectory = async (targetPath) => {
  try {
    return (await fs.promises.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
};

/** 判断路径存在 */
const pathExists = async (targetPath) => {
  try {
    await fs.promises.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

/** 判断目录存在且可写 */
const isWritableDirectory = async (targetPath) => {
  if (!(await isDirectory(targetPath))) return false;
  try {
    await fs.promises.access(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * 检测本机剪映草稿目录可用性
 * @returns {Promise<{ available: boolean, rootPath: string, canCreate: boolean, explicit: boolean, platform: NodeJS.Platform, recommendedVersion: string, reason?: string }>}
 */
export const detectDraftRoot = async () => {
  const candidates = buildDraftRootCandidates();
  const explicitRoot = getExplicitDraftRoot();

  // 优先返回第一个已存在且可写的候选目录
  for (const candidate of candidates) {
    if (await isWritableDirectory(candidate)) {
      return {
        available: true,
        rootPath: candidate,
        canCreate: true,
        explicit: Boolean(explicitRoot) && path.resolve(explicitRoot) === candidate,
        platform: process.platform,
        recommendedVersion: RECOMMENDED_VERSION,
      };
    }
  }

  // 无现成目录：若显式配置了根目录且其父目录存在，则首导出时创建
  if (explicitRoot) {
    const resolved = path.resolve(explicitRoot);
    const parentExists = await isDirectory(path.dirname(resolved));
    return {
      available: parentExists,
      rootPath: resolved,
      canCreate: parentExists,
      explicit: true,
      platform: process.platform,
      recommendedVersion: RECOMMENDED_VERSION,
      reason: parentExists
        ? 'The configured Jianying draft folder will be created on first export.'
        : 'The configured Jianying draft folder parent does not exist.',
    };
  }

  return {
    available: false,
    rootPath: candidates[0] || '',
    canCreate: false,
    explicit: false,
    platform: process.platform,
    recommendedVersion: RECOMMENDED_VERSION,
    reason: 'Jianying draft folder was not found. Start Jianying once or set JIANYING_DRAFT_ROOT.',
  };
};

/**
 * 确保草稿根目录可用（必要时创建），失败时抛出带错误码的异常
 * @returns {Promise<{ available: boolean, rootPath: string }>}
 * @throws {Error} 目录不可用（code=JIANYING_ROOT_UNAVAILABLE）或不可写（code=JIANYING_ROOT_NOT_WRITABLE）
 */
export const ensureDraftRoot = async () => {
  const capability = await detectDraftRoot();
  if (!capability.available || !capability.rootPath) {
    const error = new Error(capability.reason || 'Jianying draft folder is unavailable.');
    error.code = 'JIANYING_ROOT_UNAVAILABLE';
    throw error;
  }

  await fs.promises.mkdir(capability.rootPath, { recursive: true });
  if (!(await isWritableDirectory(capability.rootPath))) {
    const error = new Error(`Jianying draft folder is not writable: ${capability.rootPath}`);
    error.code = 'JIANYING_ROOT_NOT_WRITABLE';
    throw error;
  }
  return capability;
};

/**
 * 清洗草稿名：去除文件系统非法字符，超长截断到 96 字符
 * @param {string} raw - 原始名称
 * @param {string} [fallback] - 清洗后为空时的回退名
 * @returns {string} 安全的草稿目录名
 */
export const sanitizeDraftName = (raw, fallback = 'BigBanana_Jianying_Draft') => (
  String(raw || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/g, '')
    .trim() || fallback
).slice(0, 96);

/**
 * 清洗媒体文件名（不含扩展名）：非法字符转下划线，限长 72 字符
 * @param {string} raw - 原始名称
 * @param {string} fallback - 为空时的回退名
 * @returns {string} 安全的文件名主体
 */
export const sanitizeMediaFileName = (raw, fallback) => (
  String(raw || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 72)
) || fallback;

/**
 * 从导出 payload 的媒体描述推断扩展名（优先 MIME，其次文件名后缀）
 * @param {{ mimeType?: string, fileName?: string, kind?: 'video' | 'audio' }} media - 媒体描述
 * @returns {string} 扩展名（不含点）
 */
export const extensionFromMedia = (media) => {
  const mimeType = String(media?.mimeType || '').toLowerCase();

  if (mimeType.includes('quicktime')) return 'mov';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('ogg')) return media?.kind === 'video' ? 'ogv' : 'ogg';
  if (mimeType.includes('aac')) return 'aac';
  if (mimeType.includes('m4a') || mimeType.includes('mp4')) {
    return media?.kind === 'audio' ? 'm4a' : 'mp4';
  }

  // MIME 无法识别时退回文件名后缀
  const fromName = String(media?.fileName || '')
    .split('.')
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, '') || '';
  const audioAllowed = ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac', 'webm'];
  const videoAllowed = ['mp4', 'mov', 'webm', 'ogv'];
  const allowed = media?.kind === 'audio' ? audioAllowed : videoAllowed;
  if (allowed.includes(fromName)) return fromName;
  return media?.kind === 'audio' ? 'mp3' : 'mp4';
};

/**
 * 校验目标路径位于草稿根目录内，防止路径穿越
 * @param {string} root - 草稿根目录
 * @param {string} target - 目标路径
 * @returns {string} 通过校验的绝对路径
 * @throws {Error} 目标路径越界时抛出
 */
export const resolveWithinRoot = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new Error('Refusing to write outside the Jianying draft root.');
  }
  return resolvedTarget;
};

/** 判断路径是否存在（供导出模块做目录名去重） */
export const doesPathExist = pathExists;
