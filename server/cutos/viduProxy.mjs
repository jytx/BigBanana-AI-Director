/**
 * Vidu（生数科技）视频生成 API 代理
 *
 * 前端不直接持有 Vidu Token 的跨域请求能力，统一经由本代理转发到
 * https://api.vidu.cn，仅放行 /ent/v2/ 业务前缀。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */

/** Vidu 开放 API 地址 */
const VIDU_API_BASE = 'https://api.vidu.cn';

/** 允许代理的 Vidu 路径前缀（企业版 v2 接口） */
const ALLOWED_PATH_PREFIX = '/ent/v2/';

/**
 * 代理转发 Vidu API 请求
 * @param {{ method?: string, path?: string, apiKey?: string, body?: object }} payload - 代理请求描述
 * @returns {Promise<{ status: number, contentType: string, text: string }>} 上游响应
 * @throws {Error} 参数缺失 / 路径非法 / 方法不支持时抛出
 */
export const proxyViduRequest = async (payload) => {
  const method = String(payload?.method || 'GET').trim().toUpperCase();
  const apiPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';

  if (!apiKey) {
    throw new Error('Missing apiKey');
  }
  if (!apiPath || !apiPath.startsWith(ALLOWED_PATH_PREFIX)) {
    throw new Error('Invalid Vidu path');
  }
  if (!['GET', 'POST'].includes(method)) {
    throw new Error('Unsupported method');
  }

  const response = await fetch(`${VIDU_API_BASE}${apiPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${apiKey}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(payload?.body || {}) : undefined,
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json; charset=utf-8',
    text: await response.text(),
  };
};
