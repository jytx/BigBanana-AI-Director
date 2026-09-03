/**
 * NDJSON 流式读取器
 *
 * 对接 /api/cutos/agent/stream 的逐行 JSON 响应：
 * 按换行切分、逐行解析、异常行跳过，保证长连接中断时已读行不丢失。
 */

/** 单行 JSON 解析结果：合法行为消息，非法行为 null（跳过） */
const parseNdjsonLine = (line: string): unknown | null => {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

/**
 * 读取 NDJSON 流：每解析出一条消息回调一次（同步遍历，无并发）。
 * @param response - fetch 响应（服务端以 ndjson 作为 Content-Type）
 * @param onMessage - 单条消息回调
 */
export const consumeNdjsonStream = async (
  response: Response,
  onMessage: (message: unknown) => void
): Promise<void> => {
  const body = response.body;
  if (body == null) {
    throw new Error('Response body is empty');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushLines = (finalFlush: boolean): void => {
    const lines = buffer.split('\n');
    buffer = finalFlush ? '' : (lines.pop() || '');
    for (const line of lines) {
      const message = parseNdjsonLine(line);
      if (message != null) {
        onMessage(message);
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    flushLines(false);
  }
  buffer += decoder.decode();
  flushLines(true);
};
