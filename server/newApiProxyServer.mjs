import http from 'node:http';
import { createNewApiProxyHandler } from './newApiProxyCore.mjs';

const PORT = Number.parseInt(process.env.NEW_API_PROXY_PORT || process.env.PORT || '8788', 10);
const HOST = process.env.NEW_API_PROXY_HOST || '0.0.0.0';
// 网关请求超时（3.4.1 新增），同样作用于 Node http server 的 requestTimeout
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.NEW_API_PROXY_TIMEOUT_MS || '900000', 10);

const handler = createNewApiProxyHandler({
  defaultGatewayEndpoint: process.env.NEW_API_PROXY_DEFAULT_ENDPOINT,
  gatewayRequestTimeoutMs: REQUEST_TIMEOUT_MS,
});

const server = http.createServer((req, res) => {
  handler(req, res);
});

server.requestTimeout = REQUEST_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`new-api proxy server listening on http://${HOST}:${PORT} | timeout: ${REQUEST_TIMEOUT_MS}ms`);
});
