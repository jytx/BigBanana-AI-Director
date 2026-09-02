/**
 * KODE Agent 运行时核心
 *
 * 封装 @shareai-lab/kode-sdk 的 Agent 构建、流式对话与事件映射，
 * 为 drama（短剧导演）与 cutos（剪辑助手）两种 Agent 提供统一运行入口。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  OpenAIProvider,
  SandboxFactory,
  ToolRegistry,
} from '@shareai-lab/kode-sdk';

/** Agent 会话持久化目录（工作目录下的 .kode-bigbanana） */
export const STORE_DIR = path.resolve(process.cwd(), '.kode-bigbanana');

/** @type {import('@shareai-lab/kode-sdk').JSONStore} */
export const agentStore = new JSONStore(STORE_DIR);

/** @type {import('@shareai-lab/kode-sdk').SandboxFactory} */
const sandboxFactory = new SandboxFactory();

/**
 * @typedef {Object} ModelConfig - 前端传入的 OpenAI 兼容模型配置（BYOK）
 * @property {string} apiKey - 模型 API 密钥
 * @property {string} model - 模型 ID
 * @property {string} [apiBase] - API 基础地址（默认 https://api.openai.com）
 * @property {string} [endpoint] - 兼容端点路径（默认 /v1/chat/completions）
 */

/**
 * 解析模型 Provider 的基础 URL：
 * endpoint 含 /chat/completions 时剥掉该后缀，避免拼接出重复路径
 * @param {ModelConfig} config - 模型配置
 * @returns {string} 基础 URL
 */
const resolveProviderBaseUrl = (config) => {
  const apiBase = String(config?.apiBase || 'https://api.openai.com').replace(/\/+$/, '');
  const endpoint = String(config?.endpoint || '/v1/chat/completions');
  if (endpoint.includes('/chat/completions')) {
    return `${apiBase}${endpoint.replace(/\/chat\/completions$/, '')}`;
  }
  return `${apiBase}${endpoint.replace(/\/+$/, '')}`;
};

/**
 * 创建 OpenAI 兼容 Provider（chat 模式）
 * @param {ModelConfig} config - 模型配置
 * @returns {import('@shareai-lab/kode-sdk').OpenAIProvider}
 */
export const createModelProvider = (config) => new OpenAIProvider(
  config.apiKey,
  config.model,
  resolveProviderBaseUrl(config),
  undefined,
  { api: 'chat' },
);

/**
 * 注册工具实例并返回工具名列表
 * @param {import('@shareai-lab/kode-sdk').ToolRegistry} toolRegistry - 工具注册表
 * @param {Array<{ name: string }>} toolInstances - 工具实例列表
 * @returns {string[]} 已注册的工具名
 */
const registerTools = (toolRegistry, toolInstances) => {
  const toolNames = [];
  toolInstances.forEach((instance) => {
    toolRegistry.register(instance.name, () => instance);
    toolNames.push(instance.name);
  });
  return toolNames;
};

/**
 * 组装 Agent 依赖：会话模板（系统提示词 + 工具 + 自动权限）与注册表
 * @param {object} options
 * @param {string} options.templateId - 模板 ID（bigbanana-drama-kode / bigbanana-cutos-kode）
 * @param {string} options.systemPrompt - 系统提示词
 * @param {Array<{ name: string }>} options.toolInstances - 工具实例
 * @param {Record<string, unknown>} [options.metadata] - 模板元数据
 * @returns {{ deps: object, toolNames: string[] }}
 */
export const createAgentDeps = ({ templateId, systemPrompt, toolInstances, metadata }) => {
  const templateRegistry = new AgentTemplateRegistry();
  const toolRegistry = new ToolRegistry();
  const toolNames = registerTools(toolRegistry, toolInstances);

  templateRegistry.register({
    id: templateId,
    name: templateId,
    systemPrompt,
    tools: toolNames,
    // 自动执行工具，剪辑/生产类动作无需人工审批
    permission: { mode: 'auto' },
    runtime: {
      exposeThinking: false,
      retainThinking: false,
      metadata,
    },
  });

  return {
    deps: {
      store: agentStore,
      templateRegistry,
      sandboxFactory,
      toolRegistry,
    },
    toolNames,
  };
};

/** 解析时间为毫秒时间戳，非法值返回 undefined */
const toTimestamp = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * 提取工具结果的输出摘要（超长 JSON 截断到 240 字符）
 * @param {unknown} result - 工具执行结果
 * @returns {string | undefined} 摘要文本
 */
export const summarizeOutput = (result) => {
  if (result == null) return undefined;
  if (typeof result === 'string') {
    return result.trim() || undefined;
  }
  if (typeof result?.summary === 'string' && result.summary.trim()) {
    return result.summary.trim();
  }
  try {
    const serialized = JSON.stringify(result);
    return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
  } catch {
    return String(result);
  }
};

/**
 * 加载指定 Agent 会话中的工具调用记录（按 ID 映射）
 * @param {string} agentId - Agent 会话 ID
 * @param {string[]} toolCallIds - 工具调用 ID 列表
 * @returns {Promise<Array<{ id: string, name: string, input: object, result: unknown, error: string | undefined, status: string, state: string, durationMs: number | undefined }>>}
 */
export const loadToolCallRecords = async (agentId, toolCallIds) => {
  const records = await agentStore.loadToolCallRecords(agentId);
  const recordById = new Map(records.map((record) => [record.id, record]));
  return toolCallIds
    .map((id) => recordById.get(id))
    .filter(Boolean)
    .map((record) => ({
      id: record.id,
      name: record.name,
      input: record.input,
      result: record.result,
      error: record.error,
      status: record.state === 'COMPLETED' ? 'success' : 'error',
      state: record.state,
      durationMs: record.durationMs,
    }));
};

/**
 * 将 kode-sdk 流事件映射为前端可消费的简化事件（文本/工具/done）
 * @param {{ cursor: number, bookmark?: { seq: number }, event: { type: string, [key: string]: unknown } }} envelope - 事件信封
 * @returns {Record<string, unknown> | null} 简化事件，无需下发时返回 null
 */
export const mapStreamEvent = (envelope) => {
  const event = envelope.event;
  const cursor = {
    id: `${envelope.bookmark?.seq || envelope.cursor || Date.now()}`,
    step: typeof event?.step === 'number' ? event.step : undefined,
  };

  if (event.type === 'text_chunk_end') {
    const text = String(event.text || '').trim();
    return text ? { ...cursor, type: 'text', text } : null;
  }

  if (event.type === 'tool:start' || event.type === 'tool:end' || event.type === 'tool:error') {
    return {
      ...cursor,
      type: event.type,
      toolCallId: event.call?.id,
      toolName: event.call?.name || '',
      input: event.call?.inputPreview && typeof event.call.inputPreview === 'object'
        ? event.call.inputPreview
        : {},
      error: (event.type === 'tool:error' && String(event.error || '').trim()) || undefined,
      state: event.call?.state,
      durationMs: event.call?.durationMs,
    };
  }

  if (event.type === 'done') {
    return { ...cursor, type: 'done', reason: event.reason };
  }

  return null;
};

/**
 * 运行 KODE Agent 一次对话：消费 chatStream，聚合文本与工具调用结果
 * @param {object} options
 * @param {string} options.agentId - Agent 会话 ID（支持断点续聊）
 * @param {string} options.templateId - 会话模板 ID
 * @param {string} options.systemPrompt - 系统提示词
 * @param {string} options.input - 用户输入
 * @param {ModelConfig} options.modelConfig - 模型配置
 * @param {Array<{ name: string }>} options.toolInstances - 工具实例
 * @param {Record<string, unknown>} [options.metadata] - 会话元数据
 * @param {(delta: { delta: string, text: string }) => Promise<void>} [options.onTextDelta] - 文本增量回调
 * @param {(event: Record<string, unknown>) => Promise<void>} [options.onEvent] - 事件回调
 * @returns {Promise<{ agentId: string, text: string, toolCalls: object[], events: object[] }>}
 */
export const runKodeAgent = async ({
  agentId,
  templateId,
  systemPrompt,
  input,
  modelConfig,
  toolInstances,
  metadata,
  onTextDelta,
  onEvent,
}) => {
  if (!agentId) throw new Error('Missing agentId');
  if (!systemPrompt || !String(systemPrompt).trim()) throw new Error('Missing systemPrompt');
  if (!input || !String(input).trim()) throw new Error('Missing input');
  if (!modelConfig?.apiKey || !modelConfig?.model) {
    throw new Error('Missing modelConfig.apiKey or modelConfig.model');
  }

  const provider = createModelProvider(modelConfig);
  const { deps, toolNames } = createAgentDeps({
    templateId,
    systemPrompt,
    toolInstances,
    metadata,
  });

  const agent = await Agent.resumeOrCreate(
    agentId,
    {
      agentId,
      templateId,
      model: provider,
      tools: toolNames,
      sandbox: { kind: 'local', workDir: process.cwd(), enforceBoundary: false },
      metadata,
    },
    deps,
    { autoRun: false },
  );

  let accumulatedText = '';
  let finalText = '';
  /** @type {string[]} */
  const toolCallIdOrder = [];
  const seenToolCallIds = new Set();
  /** @type {object[]} */
  const rawEvents = [];

  for await (const envelope of agent.chatStream(String(input))) {
    const event = envelope.event;
    rawEvents.push(envelope);

    if (event.type === 'text_chunk') {
      accumulatedText += event.delta;
      if (typeof onTextDelta === 'function') {
        await onTextDelta({ delta: event.delta, text: accumulatedText });
      }
      continue;
    }

    const mapped = mapStreamEvent(envelope);
    if (mapped && typeof onEvent === 'function') {
      await onEvent(mapped);
    }

    if (event.type === 'text_chunk_end') {
      finalText = event.text || finalText;
      continue;
    }

    if ((event.type === 'tool:start' || event.type === 'tool:end' || event.type === 'tool:error') && event.call?.id) {
      if (!seenToolCallIds.has(event.call.id)) {
        seenToolCallIds.add(event.call.id);
        toolCallIdOrder.push(event.call.id);
      }
    }
  }

  const toolCalls = await loadToolCallRecords(agentId, toolCallIdOrder);
  return {
    agentId,
    text: (finalText || accumulatedText).trim(),
    toolCalls,
    events: decorateEvents(rawEvents, toolCalls),
  };
};

/**
 * 为原始事件流补全工具调用明细（名称、入参、结果、耗时）
 * @param {Array<{ cursor: number, bookmark?: { seq: number }, event: object }>} envelopes - 原始事件信封列表
 * @param {Array<{ id: string, name: string, input: object, result: unknown, error: string | undefined, state: string, durationMs: number | undefined }>} toolCalls - 工具调用明细
 * @returns {object[]} 装饰后的事件列表
 */
export const decorateEvents = (envelopes, toolCalls) => {
  const toolCallById = new Map(toolCalls.map((call) => [call.id, call]));
  return envelopes
    .map((envelope) => {
      const mapped = mapStreamEvent(envelope);
      if (!mapped) return null;

      if (mapped.type === 'tool:start' || mapped.type === 'tool:end' || mapped.type === 'tool:error') {
        const detail = toolCallById.get(mapped.toolCallId) || null;
        return {
          ...mapped,
          toolName: mapped.toolName || detail?.name || '',
          input: detail?.input && typeof detail.input === 'object' ? detail.input : mapped.input || {},
          result: detail?.result,
          outputSummary: summarizeOutput(detail?.result),
          error: mapped.type === 'tool:error'
            ? String(mapped.error || detail?.error || '').trim() || undefined
            : String(detail?.error || '').trim() || undefined,
          state: mapped.state || detail?.state,
          durationMs: detail?.durationMs ?? mapped.durationMs,
        };
      }

      return mapped;
    })
    .filter(Boolean);
};

/** 导出供会话管理模块复用的时间解析 */
export { toTimestamp };
