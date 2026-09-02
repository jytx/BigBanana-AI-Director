/**
 * cutos-api 公共 HTTP 工具
 *
 * 提供：NDJSON 流式响应、apiBase 相对路径解析、base64 媒体载荷解析。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */

/**
 * 初始化 NDJSON 流式响应头并立即下发（用于 Agent 流式接口）
 * @param {import('express').Response} res - Express 响应对象
 * @returns {void}
 */
export const startNdjsonStream = (res) => {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
};

/**
 * 向 NDJSON 流写入一行 JSON 事件
 * @param {import('express').Response} res - Express 响应对象
 * @param {Record<string, unknown>} payload - 事件载荷
 * @returns {void}
 */
export const writeNdjsonLine = (res, payload) => {
  res.write(`${JSON.stringify(payload)}\n`);
};

/**
 * 从请求头推断对外访问的基础 URL（协议 + 主机）
 * @param {import('express').Request} req - Express 请求对象
 * @returns {string} 形如 https://host 的基础 URL，无法推断时返回空串
 */
export const resolveRequestBaseUrl = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  return host ? `${proto}://${host}` : '';
};

/**
 * 解析请求体中的 modelConfig：当 apiBase 是相对路径（如 /api/antsk-proxy）
 * 时，拼接为当前站点的绝对地址，便于 OpenAI 兼容客户端直连
 * @template T
 * @param {import('express').Request} req - Express 请求对象
 * @param {T} body - 请求体（含可选 modelConfig.apiBase）
 * @returns {T} 处理后的请求体（纯函数，不修改入参）
 */
export const resolveRelativeApiBase = (req, body) => {
  const apiBase = String(body?.modelConfig?.apiBase || '').trim();
  // 已是绝对地址或未配置时直接返回
  if (!apiBase || /^https?:\/\//i.test(apiBase)) {
    return body;
  }

  const baseUrl = resolveRequestBaseUrl(req);
  if (!baseUrl) {
    return body;
  }

  const normalizedPath = apiBase.startsWith('/') ? apiBase : `/${apiBase}`;
  return {
    ...body,
    modelConfig: {
      ...body.modelConfig,
      apiBase: `${baseUrl}${normalizedPath}`,
    },
  };
};

/**
 * 校验并清洗 base64 载荷（兼容 data URL 前缀，去除空白字符）
 * @param {string} value - 原始 base64 或 data URL 字符串
 * @returns {string} 纯 base64 字符串
 * @throws {Error} 载荷不是合法 base64 时抛出
 */
export const normalizeBase64Payload = (value) => {
  const pure = String(value || '')
    .replace(/^data:[^,]+,/i, '')
    .replace(/\s+/g, '');
  if (!pure || pure.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(pure)) {
    throw new Error('Media payload is not valid base64.');
  }
  return pure;
};

/**
 * 将 base64 载荷解码为 Buffer
 * @param {string} value - 原始 base64 或 data URL 字符串
 * @returns {Buffer} 解码后的二进制内容
 * @throws {Error} 载荷为空时抛出
 */
export const decodeBase64ToBuffer = (value) => {
  const buffer = Buffer.from(normalizeBase64Payload(value), 'base64');
  if (buffer.length === 0) {
    throw new Error('Media payload is empty.');
  }
  return buffer;
};

/**
 * 将 Buffer 编码为 data URL
 * @param {Buffer} buffer - 二进制内容
 * @param {string} mimeType - MIME 类型，默认 audio/wav
 * @returns {string} data URL 字符串
 */
export const encodeBufferToDataUrl = (buffer, mimeType = 'audio/wav') => {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

/**
 * 解析 data URL 为 { buffer, contentType, extension }
 * @param {string} dataUrl - data URL 字符串
 * @returns {{ buffer: Buffer, contentType: string, extension: string }}
 * @throws {Error} 格式非法时抛出
 */
export const parseDataUrl = (dataUrl) => {
  const match = String(dataUrl).match(
    /^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,([\s\S]+)$/i
  );
  if (!match) {
    throw new Error('Invalid data URL payload');
  }

  const contentType = match[1] || 'application/octet-stream';
  const base64Body = match[2] || '';
  return {
    buffer: Buffer.from(base64Body, 'base64'),
    contentType,
    extension: extensionFromContentType(contentType) || 'bin',
  };
};

/**
 * 从 MIME 类型推断媒体扩展名（覆盖常见音视频容器）
 * @param {string} contentType - MIME 类型
 * @returns {string} 扩展名（不含点），无法识别返回空串
 */
export const extensionFromContentType = (contentType = '') => {
  const lower = String(contentType).toLowerCase();
  if (lower.includes('quicktime')) return 'mov';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('aac')) return 'aac';
  if (lower.includes('m4a') || lower.includes('mp4') || lower.includes('audio/mp4')) return 'mp4';
  return '';
};

/**
 * 从 URL 路径推断媒体扩展名（去除查询串后按后缀判断）
 * @param {string} url - 媒体 URL
 * @returns {string} 扩展名（不含点），无法识别返回空串
 */
export const extensionFromUrl = (url = '') => {
  const path = String(url).split('?')[0].toLowerCase();
  if (path.endsWith('.mov')) return 'mov';
  if (path.endsWith('.webm')) return 'webm';
  if (path.endsWith('.wav')) return 'wav';
  if (path.endsWith('.mp3')) return 'mp3';
  if (path.endsWith('.ogg') || path.endsWith('.ogv')) return 'ogg';
  if (path.endsWith('.aac')) return 'aac';
  if (path.endsWith('.m4a') || path.endsWith('.mp4')) return 'mp4';
  return '';
};
