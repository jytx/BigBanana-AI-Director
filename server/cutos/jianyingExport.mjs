/**
 * 剪映草稿导出：payload 校验与草稿落盘
 *
 * 校验前端提交的 { draftInfo, media } 载荷（素材引用完整、
 * 时间区间合法、大小在限额内），随后以"临时目录 + 原子重命名"
 * 方式写入剪映草稿目录（draft_info.json 等四件套）。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_COUNT,
  doesPathExist,
  ensureDraftRoot,
  extensionFromMedia,
  resolveWithinRoot,
  sanitizeDraftName,
  sanitizeMediaFileName,
} from './jianyingPaths.mjs';
import { decodeBase64ToBuffer, normalizeBase64Payload } from './httpHelpers.mjs';

/** 剪映草稿目录中的必备文件清单 */
export const DRAFT_FILES = ['draft_info.json', 'draft_meta_info.json', 'draft_settings', 'key_value.json'];

/** 是否为普通对象（非数组） */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 深拷贝普通对象 */
const cloneObject = (value) => (isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : {});

/** 提取素材 ID（兼容 id / material_id / music_id 字段名） */
const extractMaterialId = (material) => String(
  material?.id || material?.material_id || material?.music_id || ''
).trim();

/** 收集草稿中已声明的视频/音频素材 ID 集合 */
const collectDeclaredMaterialIds = (draftInfo) => {
  const videos = Array.isArray(draftInfo?.materials?.videos) ? draftInfo.materials.videos : [];
  const audios = Array.isArray(draftInfo?.materials?.audios) ? draftInfo.materials.audios : [];
  return new Set([...videos, ...audios].map(extractMaterialId).filter(Boolean));
};

/** 时间区间是否为合法的非负整数区间 */
const isValidTimerange = (range) => isPlainObject(range)
  && Number.isSafeInteger(Number(range.start))
  && Number.isSafeInteger(Number(range.duration))
  && Number(range.start) >= 0
  && Number(range.duration) > 0;

/**
 * 校验导出 payload 的完整性与合法性（纯校验，不产生副作用）
 * @param {{ draftInfo: object, draftMetaInfo?: object, draftSettings?: string, keyValue?: object, draftName?: string, media?: Array<{ materialId: string, kind: 'video' | 'audio', data: string, fileName?: string, mimeType?: string }>, draftInfoWarnings?: string[] }} payload - 导出载荷
 * @returns {{ estimatedBytes: number }} 预计写入字节数
 * @throws {Error} 任何结构性/引用性/限额性问题时抛出
 */
export const validateExportPayload = (payload) => {
  if (!isPlainObject(payload)) throw new Error('Export payload must be a JSON object.');
  if (!isPlainObject(payload.draftInfo)) throw new Error('Missing draftInfo.');
  if (!isPlainObject(payload.draftInfo.materials)) throw new Error('draftInfo.materials is missing.');

  // 补齐可选的素材数组，后续统一按数组处理
  if (!Array.isArray(payload.draftInfo.materials.videos)) {
    payload.draftInfo.materials.videos = [];
  }
  if (!Array.isArray(payload.draftInfo.materials.audios)) {
    payload.draftInfo.materials.audios = [];
  }
  if (!Array.isArray(payload.draftInfo.tracks)) throw new Error('draftInfo.tracks must be an array.');
  if (!Array.isArray(payload.media)) throw new Error('media must be an array.');
  if (payload.media.length > MAX_MEDIA_COUNT) {
    throw new Error(`Too many media files (limit ${MAX_MEDIA_COUNT}).`);
  }

  // 素材声明：ID 唯一且记录时长（微秒）
  const declaredMaterialIds = collectDeclaredMaterialIds(payload.draftInfo);
  /** @type {Map<string, 'video' | 'audio'>} */
  const materialKindById = new Map();
  /** @type {Map<string, number>} */
  const materialDurationById = new Map();
  for (const [kind, materials] of [['video', payload.draftInfo.materials.videos], ['audio', payload.draftInfo.materials.audios]]) {
    materials.forEach((material) => {
      const materialId = extractMaterialId(material);
      if (!materialId) throw new Error(`A ${kind} material is missing its id.`);
      if (materialKindById.has(materialId)) {
        throw new Error(`Duplicate draft material id: ${materialId}`);
      }
      materialKindById.set(materialId, kind);
      materialDurationById.set(materialId, Number(material.duration));
    });
  }

  // 媒体载荷：引用存在、类型匹配、base64 合法、总量在限额内
  /** @type {Set<string>} */
  const uploadedMaterialIds = new Set();
  let estimatedBytes = 0;
  payload.media.forEach((mediaItem, index) => {
    if (!isPlainObject(mediaItem)) throw new Error(`media[${index}] is invalid.`);

    const materialId = String(mediaItem.materialId || '').trim();
    if (!materialId || !declaredMaterialIds.has(materialId)) {
      throw new Error(`media[${index}] references an unknown material.`);
    }
    if (uploadedMaterialIds.has(materialId)) {
      throw new Error(`Duplicate media material id: ${materialId}`);
    }
    uploadedMaterialIds.add(materialId);

    if (!['video', 'audio'].includes(mediaItem.kind)) {
      throw new Error(`media[${index}] has an invalid kind.`);
    }
    if (materialKindById.get(materialId) !== mediaItem.kind) {
      throw new Error(`media[${index}] kind does not match its draft material.`);
    }

    const base64Length = normalizeBase64Payload(mediaItem.data).length;
    estimatedBytes += Math.floor(base64Length * 3 / 4);
    if (estimatedBytes > MAX_MEDIA_BYTES) {
      throw new Error(`Media payload exceeds the ${MAX_MEDIA_BYTES} byte limit.`);
    }
  });

  // 轨道与片段：素材引用、类型匹配、时间区间、源时长不越界
  /** @type {Set<string>} */
  const referencedMaterialIds = new Set();
  payload.draftInfo.tracks.forEach((track, trackIndex) => {
    if (!isPlainObject(track) || !['video', 'audio'].includes(track.type)) {
      throw new Error(`tracks[${trackIndex}] has an invalid type.`);
    }
    if (!Array.isArray(track.segments)) {
      throw new Error(`tracks[${trackIndex}].segments must be an array.`);
    }

    track.segments.forEach((segment, segmentIndex) => {
      const segmentLabel = `tracks[${trackIndex}].segments[${segmentIndex}]`;
      const materialId = String(segment?.material_id || '').trim();
      if (!materialId || !declaredMaterialIds.has(materialId)) {
        throw new Error(`${segmentLabel} references a missing material.`);
      }
      if (materialKindById.get(materialId) !== track.type) {
        throw new Error(`${segmentLabel} material type does not match its track.`);
      }
      referencedMaterialIds.add(materialId);

      if (!isValidTimerange(segment.target_timerange)) {
        throw new Error(`${segmentLabel} has an invalid target timerange.`);
      }
      if (!isValidTimerange(segment.source_timerange)) {
        throw new Error(`${segmentLabel} has an invalid source timerange.`);
      }

      // 源区间末尾允许 1ms 容差
      const materialDuration = materialDurationById.get(materialId);
      const sourceEnd = Number(segment.source_timerange.start) + Number(segment.source_timerange.duration);
      if (Number.isFinite(materialDuration) && materialDuration > 0 && sourceEnd > materialDuration + 1000) {
        throw new Error(`${segmentLabel} exceeds its source material duration.`);
      }
    });
  });

  // 每个被引用的素材都必须有对应上传文件
  for (const materialId of referencedMaterialIds) {
    if (!uploadedMaterialIds.has(materialId)) {
      throw new Error(`No uploaded file for material ${materialId}.`);
    }
  }

  return { estimatedBytes };
};

/** 生成默认的 draft_meta_info.json 内容（云同步相关字段全部置空） */
const buildDefaultDraftMetaInfo = (draftId, draftName) => ({
  cloud_package_completed_time: '',
  draft_cloud_capcut_purchase_info: '',
  draft_cloud_last_action_download: false,
  draft_cloud_materials: [],
  draft_cloud_purchase_info: '',
  draft_cloud_template_id: '',
  draft_cloud_tutorial_info: '',
  draft_cloud_videocut_purchase_info: '',
  draft_cover: '',
  draft_deeplink_url: '',
  draft_enterprise_info: {
    draft_enterprise_extra: '',
    draft_enterprise_id: '',
    draft_enterprise_name: '',
    enterprise_material: [],
  },
  draft_fold_path: '',
  draft_id: draftId,
  draft_is_ai_packaging_used: false,
  draft_is_ai_shorts: false,
  draft_is_ai_translate: false,
  draft_is_article_video_draft: false,
  draft_is_from_deeplink: 'false',
  draft_is_invisible: false,
  draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })),
  draft_materials_copied_info: [],
  draft_name: draftName,
  draft_new_version: '',
  draft_removable_storage_device: '',
  draft_root_path: '',
  draft_segment_extra_info: [],
  draft_type: '',
  tm_draft_cloud_completed: '',
  tm_draft_cloud_modified: 0,
  tm_draft_removed: 0,
  tm_duration: 0,
});

/** 生成默认的 draft_settings 内容 */
const buildDefaultDraftSettings = () => (
  '[General]\ndraft_create_time=0\ndraft_last_edit_time=0\nreal_edit_keys=1\nreal_edit_seconds=0\n'
);

/**
 * 在根目录内为草稿生成不冲突的目录名（重名追加 _1、_2 …）
 * @param {string} rootPath - 草稿根目录
 * @param {string} desiredName - 期望的草稿名
 * @returns {Promise<string>} 可用的目录名
 */
const allocateDraftFolderName = async (rootPath, desiredName) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? desiredName : `${desiredName}_${attempt}`;
    if (!(await doesPathExist(path.join(rootPath, candidate)))) {
      return candidate;
    }
  }
  return `${desiredName}_${Date.now()}`;
};

/**
 * 执行剪映草稿导出（先校验后写入，失败自动清理临时目录）
 * @param {Parameters<typeof validateExportPayload>[0]} payload - 导出载荷
 * @returns {Promise<{ success: true, draftName: string, draftPath: string, rootPath: string, mediaCount: number, clipCount: number, warnings: string[], files: string[] }>}
 */
export const exportJianyingDraft = async (payload) => {
  validateExportPayload(payload);

  const capability = await ensureDraftRoot();
  const requestedName = sanitizeDraftName(payload.draftName || payload.draftInfo.name);
  const folderName = await allocateDraftFolderName(capability.rootPath, requestedName);

  const draftId = String(payload.draftInfo.id || crypto.randomUUID()).trim() || crypto.randomUUID();
  const draftFolderPath = resolveWithinRoot(
    capability.rootPath,
    path.join(capability.rootPath, folderName),
  );

  // 先写临时目录，成功后原子重命名，避免剪映读到半成品草稿
  const stagingDir = await fs.promises.mkdtemp(
    path.join(capability.rootPath, `.bigbanana-jianying-${process.pid}-`)
  );
  const stagingMediaDir = resolveWithinRoot(stagingDir, path.join(stagingDir, 'media'));
  await fs.promises.mkdir(stagingMediaDir, { recursive: true });

  const draftInfo = cloneObject(payload.draftInfo);
  const draftMetaInfo = isPlainObject(payload.draftMetaInfo)
    ? cloneObject(payload.draftMetaInfo)
    : buildDefaultDraftMetaInfo(draftId, folderName);
  /** @type {string[]} */
  const warnings = Array.isArray(payload.draftInfoWarnings) ? payload.draftInfoWarnings.map(String) : [];

  try {
    // 1. 写入媒体文件，并记录"素材 ID → 草稿内最终路径"映射
    /** @type {Map<string, string>} */
    const mediaPathByMaterialId = new Map();
    for (let index = 0; index < payload.media.length; index += 1) {
      const mediaItem = payload.media[index];
      const extension = extensionFromMedia(mediaItem);
      const baseName = sanitizeMediaFileName(
        mediaItem.fileName?.replace(/\.[^.]+$/, ''),
        `${mediaItem.kind}_${index + 1}`,
      );
      const fileName = `${mediaItem.kind}_${String(index + 1).padStart(3, '0')}_${baseName}.${extension}`;

      const stagingFilePath = resolveWithinRoot(stagingMediaDir, path.join(stagingMediaDir, fileName));
      const finalFilePath = resolveWithinRoot(draftFolderPath, path.join(draftFolderPath, 'media', fileName));
      await fs.promises.writeFile(stagingFilePath, decodeBase64ToBuffer(mediaItem.data));
      mediaPathByMaterialId.set(String(mediaItem.materialId), finalFilePath);
    }

    // 2. 回填素材本地路径与草稿元信息
    (draftInfo.materials.videos || []).forEach((material) => {
      const finalPath = mediaPathByMaterialId.get(extractMaterialId(material));
      if (finalPath) {
        material.path = finalPath;
        material.media_path = material.media_path || '';
      }
    });
    (draftInfo.materials.audios || []).forEach((material) => {
      const finalPath = mediaPathByMaterialId.get(extractMaterialId(material));
      if (finalPath) {
        material.path = finalPath;
      }
    });

    const now = Date.now();
    draftInfo.id = draftId;
    draftInfo.name = folderName;
    draftInfo.create_time = Number(draftInfo.create_time) || now;
    draftInfo.update_time = now;
    draftInfo.platform = {
      ...(draftInfo.platform || {}),
      os: process.platform === 'darwin' ? 'mac' : 'windows',
    };
    draftInfo.last_modified_platform = {
      ...(draftInfo.last_modified_platform || {}),
      os: process.platform === 'darwin' ? 'mac' : 'windows',
    };

    draftMetaInfo.draft_id = draftId;
    draftMetaInfo.draft_name = folderName;
    draftMetaInfo.draft_fold_path = draftFolderPath;
    draftMetaInfo.draft_root_path = capability.rootPath;
    draftMetaInfo.tm_duration = Number(draftInfo.duration) || 0;

    // draft_materials 前两槽位分别登记视频/音频素材 ID
    if (Array.isArray(draftMetaInfo.draft_materials)) {
      const videoIds = (draftInfo.materials.videos || []).map(extractMaterialId).filter(Boolean);
      const audioIds = (draftInfo.materials.audios || []).map(extractMaterialId).filter(Boolean);
      if (draftMetaInfo.draft_materials[0]) draftMetaInfo.draft_materials[0].value = videoIds;
      if (draftMetaInfo.draft_materials[1]) draftMetaInfo.draft_materials[1].value = audioIds;
    }

    // 3. 写入草稿四件套
    const writeJson = (filePath, data) => fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    const draftSettings = typeof payload.draftSettings === 'string' && payload.draftSettings.trim()
      ? payload.draftSettings
      : buildDefaultDraftSettings();
    const keyValue = isPlainObject(payload.keyValue) ? cloneObject(payload.keyValue) : {};

    await writeJson(path.join(stagingDir, 'draft_info.json'), draftInfo);
    await writeJson(path.join(stagingDir, 'draft_meta_info.json'), draftMetaInfo);
    await fs.promises.writeFile(path.join(stagingDir, 'draft_settings'), draftSettings, 'utf8');
    await writeJson(path.join(stagingDir, 'key_value.json'), keyValue);

    // 4. 原子切换：临时目录重命名为正式草稿目录
    await fs.promises.rename(stagingDir, draftFolderPath);
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  if (folderName !== requestedName) {
    warnings.push(`A draft named ${requestedName} already existed; created ${folderName} instead.`);
  }

  const clipCount = (draftInfo.tracks || []).reduce(
    (total, track) => total + (Array.isArray(track.segments) ? track.segments.length : 0),
    0,
  );

  return {
    success: true,
    draftName: folderName,
    draftPath: draftFolderPath,
    rootPath: capability.rootPath,
    mediaCount: payload.media.length,
    clipCount,
    warnings,
    files: DRAFT_FILES,
  };
};
