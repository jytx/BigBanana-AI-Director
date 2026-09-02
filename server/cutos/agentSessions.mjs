/**
 * KODE Agent 会话管理
 *
 * 提供会话列表（含统计摘要）与会话重置能力，
 * 数据来源为 .kode-bigbanana 目录下的 JSONStore。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import { agentStore, STORE_DIR, toTimestamp } from './agentRuntime.mjs';

/** 列出全部 Agent 会话 ID（过滤空值并排序） */
const listAgentIds = async () => (await agentStore.list()).filter(Boolean).sort();

/**
 * 生成单个 Agent 会话的统计摘要（消息数 / 工具调用数 / 时间戳）
 * @param {string} agentId - Agent 会话 ID
 * @returns {Promise<{ agentId: string, templateId: string, messageCount: number, toolCallCount: number, createdAt: string | undefined, updatedAt: number | undefined }>}
 */
const getSessionSummary = async (agentId) => {
  const [info, messages, toolCallRecords] = await Promise.all([
    agentStore.loadInfo(agentId),
    agentStore.loadMessages(agentId),
    agentStore.loadToolCallRecords(agentId),
  ]);

  // 最近一次工具活动时间（完成/更新/创建中取最大）
  const lastToolActivityAt = toolCallRecords.reduce((latest, record) => {
    const candidates = [record.updatedAt, record.completedAt, record.createdAt]
      .map(toTimestamp)
      .filter(Boolean);
    return Math.max(latest, ...candidates, 0);
  }, 0);

  const createdAt = toTimestamp(info?.createdAt);
  return {
    agentId,
    templateId: info?.templateId || '',
    messageCount: messages.length,
    toolCallCount: toolCallRecords.length,
    createdAt: info?.createdAt,
    updatedAt: Math.max(createdAt || 0, lastToolActivityAt || 0) || undefined,
  };
};

/**
 * 列出（可按前缀过滤的）Agent 会话及统计信息，按更新时间倒序
 * @param {object} [options]
 * @param {string} [options.prefix] - 会话 ID 前缀过滤
 * @returns {Promise<{ storeDir: string, totalSessions: number, matchingSessions: number, sessions: object[] }>}
 */
export const listAgentSessions = async ({ prefix } = {}) => {
  const [allIds, matchedIds] = await Promise.all([
    listAgentIds(),
    prefix ? listAgentIdsByPrefix(prefix) : Promise.resolve([]),
  ]);
  const summaries = await Promise.all(matchedIds.map(getSessionSummary));
  summaries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return {
    storeDir: STORE_DIR,
    totalSessions: allIds.length,
    matchingSessions: summaries.length,
    sessions: summaries,
  };
};

/** 列出匹配指定前缀的会话 ID */
const listAgentIdsByPrefix = async (prefix) => {
  const ids = await listAgentIds();
  return ids.filter((id) => id.startsWith(prefix));
};

/**
 * 重置 Agent 会话：按 ID / 前缀 / 全部三种方式删除
 * @param {object} [options]
 * @param {string} [options.agentId] - 指定会话 ID
 * @param {string} [options.prefix] - 会话 ID 前缀
 * @param {boolean} [options.resetAll] - 是否清空全部会话
 * @returns {Promise<{ storeDir: string, deletedAgentIds: string[], deletedCount: number, remainingCount: number }>}
 * @throws {Error} 未指定任何删除目标时抛出
 */
export const resetAgentSessions = async ({ agentId, prefix, resetAll } = {}) => {
  /** @type {string[]} */
  let targets = [];
  if (agentId) {
    targets = [String(agentId)];
  } else if (resetAll) {
    targets = await listAgentIds();
  } else if (prefix) {
    targets = await listAgentIdsByPrefix(prefix);
  } else {
    throw new Error('Missing reset target');
  }

  const uniqueTargets = Array.from(new Set(targets.filter(Boolean)));
  await Promise.all(uniqueTargets.map((id) => agentStore.delete(id)));

  const remaining = await listAgentIds();
  return {
    storeDir: STORE_DIR,
    deletedAgentIds: uniqueTargets,
    deletedCount: uniqueTargets.length,
    remainingCount: remaining.length,
  };
};
