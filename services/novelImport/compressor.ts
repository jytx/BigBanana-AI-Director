/**
 * 多层压缩层：摘要节点过多时逐层归并为高层剧情阶段
 *
 * 目的：无论小说多长，进入分集规划的节点数始终收敛到上限以内。
 * 主路径为 LLM 压缩（小说结构编辑助手提示词），
 * 失败时降级为确定性合并（标题/摘要/事件/角色按规则拼接）。
 */

import { chatCompletion, parseJsonWithRecovery, retryOperation } from '../ai/apiCore';
import { buildCompressionPrompt } from './prompts';
import {
  clampNumber,
  dedupeStrings,
  makeCompressionNodeId,
  runWithConcurrency,
  throwIfAborted,
  truncateHead,
} from './sectioning';
import { LlmCallContext, SectionSummary } from './types';

/** LLM 压缩结果的最小结构 */
interface RawCompressionResult {
  title?: unknown;
  summary?: unknown;
  keyEvents?: unknown;
  characters?: unknown;
  hook?: unknown;
}

/** 压缩主流程的完整入参（onProgress 由主编排透传） */
export interface CompressionInput extends LlmCallContext {
  nodes: SectionSummary[];
  maxNodeCount: number;
  onProgress: ((message: string) => void) | undefined;
}

/** 确定性合并降级：不依赖 LLM，按规则把一组节点拼成一个高层阶段节点 */
export const buildMergedNode = (
  nodes: SectionSummary[],
  layer: number,
  groupIndex: number
): SectionSummary => {
  const first = nodes[0];
  const last = nodes[nodes.length - 1] || first;
  const title =
    first != null && last != null && first.title !== last.title
      ? `${first.title} - ${last.title}`
      : first?.title || `剧情阶段 ${groupIndex + 1}`;
  const keyEvents = dedupeStrings(
    nodes.flatMap((node) => node.keyEvents.map((event) => truncateHead(event, 70)))
  ).slice(0, 6);
  const characters = dedupeStrings(
    nodes.flatMap((node) => node.characters.map((name) => truncateHead(name, 24)))
  ).slice(0, 8);
  return {
    id: makeCompressionNodeId(layer, groupIndex),
    order: groupIndex + 1,
    title: truncateHead(title, 48) || `剧情阶段 ${groupIndex + 1}`,
    summary: truncateHead(nodes.map((node) => node.summary).join(' '), 220) || title,
    keyEvents: keyEvents.length > 0 ? keyEvents : [truncateHead(title, 70)],
    characters,
    hook: truncateHead(last?.hook || last?.summary || title, 100),
    sourceSectionIds: dedupeStrings(nodes.flatMap((node) => node.sourceSectionIds)),
  };
};

/** 单组节点压缩：LLM 成功时逐字段清洗回填，失败回退确定性合并 */
const compressNodeGroup = async (
  nodes: SectionSummary[],
  layer: number,
  groupIndex: number,
  ctx: LlmCallContext
): Promise<SectionSummary> => {
  const fallback = buildMergedNode(nodes, layer, groupIndex);
  try {
    const raw = await retryOperation(
      () =>
        chatCompletion(
          buildCompressionPrompt({ nodes, layer, language: ctx.language }),
          ctx.model,
          0.2,
          1400,
          'json_object',
          300000,
          ctx.abortSignal
        ),
      2,
      1200,
      ctx.abortSignal
    );
    const parsed = parseJsonWithRecovery<RawCompressionResult>(raw, {});
    const keyEvents = Array.isArray(parsed.keyEvents)
      ? parsed.keyEvents
          .map((event) => truncateHead(String(event || '').trim(), 70))
          .filter((event) => event !== '')
      : [];
    const characters = Array.isArray(parsed.characters)
      ? parsed.characters
          .map((name) => truncateHead(String(name || '').trim(), 24))
          .filter((name) => name !== '')
      : [];
    return {
      ...fallback,
      title: truncateHead(String(parsed.title || '').trim(), 48) || fallback.title,
      summary: truncateHead(String(parsed.summary || '').trim(), 220) || fallback.summary,
      keyEvents: keyEvents.length > 0 ? dedupeStrings(keyEvents).slice(0, 6) : fallback.keyEvents,
      characters: characters.length > 0 ? dedupeStrings(characters).slice(0, 8) : fallback.characters,
      hook: truncateHead(String(parsed.hook || '').trim(), 100) || fallback.hook,
    };
  } catch {
    return fallback;
  }
};

/**
 * 压缩主流程：节点数未超上限直接返回；
 * 否则按「每组 clamp(⌈n/上限⌉, 2, 6) 个节点」分组、并发 2 逐层压缩，
 * 直至节点数收敛到上限以内。
 */
export const compressSummariesIfNeeded = async (input: CompressionInput): Promise<SectionSummary[]> => {
  if (input.nodes.length <= input.maxNodeCount) {
    return input.nodes;
  }
  let current = input.nodes;
  let layer = 1;
  while (current.length > input.maxNodeCount) {
    throwIfAborted(input.abortSignal);
    const groupSize = clampNumber(Math.ceil(current.length / input.maxNodeCount), 2, 6);
    const groups: SectionSummary[][] = [];
    for (let i = 0; i < current.length; i += groupSize) {
      groups.push(current.slice(i, i + groupSize));
    }
    if (input.onProgress != null) {
      input.onProgress(
        layer === 1
          ? `正在提炼第 ${layer} 层摘要（${current.length} -> ${groups.length}）...`
          : `正在压缩高层剧情脉络（第 ${layer} 层，${current.length} -> ${groups.length}）...`
      );
    }
    current = await runWithConcurrency(groups, 2, async (group, groupIndex) => {
      throwIfAborted(input.abortSignal);
      if (input.onProgress != null) {
        input.onProgress(`正在压缩第 ${layer} 层剧情组 ${groupIndex + 1}/${groups.length}`);
      }
      return compressNodeGroup(group, layer, groupIndex, {
        model: input.model,
        language: input.language,
        abortSignal: input.abortSignal,
      });
    });
    layer += 1;
  }
  return current;
};
