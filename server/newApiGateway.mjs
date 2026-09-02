/**
 * New API 透明流式网关（3.4.1 新增）
 *
 * 将 `/api/antsk-proxy/*` 请求以流式 pipe 方式转发到默认网关端点
 * （默认 https://api.antsk.cn），用于承载 LLM 的流式响应（SSE/NDJSON）。
 * 转发过程中剥离 hop-by-hop 头，并根据配置施加请求级超时。
 */
import http from 'node:http';
import https from 'node:https';

/** 网关路由前缀（前端通过 nginx 以 /api/antsk-proxy 访问本服务） */
export const GATEWAY_PREFIX = '/api/antsk-proxy';

/** 不允许跨代理转发的逐跳（hop-by-hop）请求/响应头 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'cookie',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** 解析超时毫秒数，非法值回退 900000（15 分钟，适配长耗时 LLM 任务） */
const parseTimeoutMs = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900000;
};

/**
 * 过滤客户端请求头：剔除逐跳头，键统一小写，数组值逐项转字符串
 * @param {import('node:http').IncomingMessage} req - 客户端请求
 * @returns {Record<string, string | string[]>} 可安全转发的请求头
 */
const buildForwardableHeaders = (req) => {
  const headers = {};
  Object.entries(req.headers || {}).forEach(([rawName, rawValue]) => {
    const name = String(rawName || '').toLowerCase();
    if (!name || HOP_BY_HOP_HEADERS.has(name)) return;

    if (Array.isArray(rawValue)) {
      const values = rawValue.filter((item) => item !== undefined).map(String);
      if (values.length > 0) headers[name] = values;
      return;
    }

    if (rawValue !== undefined) {
      headers[name] = String(rawValue);
    }
  });
  return headers;
};

/**
 * 创建网关转发器
 * @param {object} options
 * @param {string} options.endpoint - 已校验的网关端点（如 https://api.antsk.cn）
 * @param {number} [options.timeoutMs] - 请求超时毫秒数，默认 900000
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, requestUrl: URL) => Promise<void>}
 */
export const createGatewayForwarder = ({ endpoint, timeoutMs }) => {
  const effectiveTimeoutMs = parseTimeoutMs(timeoutMs);

  return async (req, res, requestUrl) => {
    const method = String(req.method || 'GET').toUpperCase();
    // 去掉网关前缀后拼接上游路径与查询串，根路径保持 "/"
    const upstreamPath = requestUrl.pathname.slice(GATEWAY_PREFIX.length) || '/';
    const target = `${endpoint}${upstreamPath}${requestUrl.search}`;
    const headers = buildForwardableHeaders(req);

    await new Promise((resolve, reject) => {
      const targetUrl = new URL(target);
      const transport = targetUrl.protocol === 'https:' ? https : http;
      /** @type {import('node:http').IncomingMessage | null} */
      let upstreamResponse = null;
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const upstreamRequest = transport.request(targetUrl, { method, headers }, (response) => {
        upstreamResponse = response;
        res.statusCode = response.statusCode || 502;

        // 透传上游响应头（剔除逐跳头）
        Object.entries(response.headers).forEach(([rawName, rawValue]) => {
          const name = String(rawName || '').toLowerCase();
          if (!name || HOP_BY_HOP_HEADERS.has(name) || rawValue === undefined) return;
          res.setHeader(rawName, rawValue);
        });

        response.once('error', fail);
        // 客户端侧完成或断开均视为结束
        res.once('finish', settle);
        res.once('close', settle);
        response.pipe(res);
      });

      const timer = setTimeout(() => {
        const error = new Error(
          `New API gateway request timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds.`
        );
        error.code = 'ETIMEDOUT';
        upstreamResponse?.destroy(error);
        upstreamRequest.destroy(error);
      }, effectiveTimeoutMs);

      upstreamRequest.once('error', fail);

      req.once('aborted', () => {
        const error = new Error('Client aborted the gateway request.');
        error.code = 'ECONNABORTED';
        upstreamRequest.destroy(error);
      });

      if (method === 'GET' || method === 'HEAD') {
        upstreamRequest.end();
      } else {
        req.pipe(upstreamRequest);
      }
    });
  };
};
