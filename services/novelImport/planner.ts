/**
 * 分集规划层：把剧情摘要节点规划为 N 集的分集结构
 *
 * 主路径为 LLM 规划（资深小说改编策划提示词），
 * 失败或结果不合规时降级为等分算法；规划完成后将高层节点 id
 * 展开回原始片段 id，供草稿层按图索骥取原文。
 */

import { chatCompletion, parseJsonWithRecovery, retryOperation } from '../ai/apiCore';
import { buildPlanningPrompt } from './prompts';
import { clampNumber, dedupeStrings, truncateHead } from './sectioning';
import { EpisodePlan, EpisodePlanningOutcome, LlmCallContext, SectionSummary } from './types';

/** LLM 规划结果的最小结构 */
interface RawPlanningResult {
  projectTitle?: unknown;
  projectDescription?: unknown;
  seriesTitle?: unknown;
  episodes?: unknown;
}

/** 规划主流程完整入参 */
export interface PlanningInput extends LlmCallContext {
  projectTitleSuggestion: string;
  sectionSummaries: SectionSummary[];
  episodeCount: number;
  targetDuration: string;
  durationGuide: string;
  preferredSeriesTitle: string;
}

/** 等分降级：按节点顺序均分为 N 集，直接拼出可用的分集结构 */
export const splitNodesEvenly = (nodes: SectionSummary[], episodeCount: number): EpisodePlan[] => {
  const count = clampNumber(episodeCount, 1, Math.max(1, nodes.length));
  if (nodes.length === 0) {
    return [];
  }
  const groups: SectionSummary[][] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * nodes.length) / count);
    const end = Math.min(nodes.length, Math.max(start + 1, Math.floor(((i + 1) * nodes.length) / count)));
    groups.push(nodes.slice(start, end));
  }
  return groups.map((group, index) => ({
    episodeNumber: index + 1,
    title: group[0]?.title || `第 ${index + 1} 集`,
    summary: truncateHead(group.map((node) => node.summary).join(' '), 220),
    hook: group[group.length - 1]?.hook || `第 ${index + 1} 集结尾抛出新悬念。`,
    focus:
      truncateHead(group.flatMap((node) => node.keyEvents).slice(0, 3).join('；'), 140) || '推进主线冲突。',
    sourceSectionIds: group.map((node) => node.id),
  }));
};

/**
 * 规划结果校验与回退：
 * - 逐集字段清洗（episodeNumber 夹取 1-24，标题/摘要/钩子/焦点截断并回退等分结果）；
 * - sourceSectionIds 过滤白名单并按原文顺序排序；
 * - 整体校验（集数一致、各集片段严格有序不重叠且全覆盖），不合规整体回退等分。
 */
export const normalizeEpisodePlans = (
  rawEpisodes: unknown,
  nodes: SectionSummary[],
  episodeCount: number
): EpisodePlan[] => {
  const validIds = new Set(nodes.map((node) => node.id));
  const orderById = new Map(nodes.map((node) => [node.id, node.order]));
  const fallbackPlans = splitNodesEvenly(nodes, episodeCount);
  if (!Array.isArray(rawEpisodes) || rawEpisodes.length === 0) {
    return fallbackPlans;
  }
  const plans = (rawEpisodes as unknown[]).map((item, index) => {
    const raw = (item || {}) as Record<string, unknown>;
    const fallback = fallbackPlans[index];
    const rawIds = Array.isArray(raw.sourceSectionIds)
      ? dedupeStrings(
          (raw.sourceSectionIds as unknown[]).map((id) => String(id || '').trim()).filter((id) => validIds.has(id))
        ).sort((a, b) => (orderById.get(a) || 0) - (orderById.get(b) || 0))
      : [];
    const rawNumber = Number(raw.episodeNumber);
    return {
      episodeNumber: Number.isFinite(rawNumber) ? clampNumber(rawNumber, 1, 24) : index + 1,
      title:
        truncateHead(String(raw.title || '').trim(), 48) || fallback?.title || `第 ${index + 1} 集`,
      summary:
        truncateHead(String(raw.summary || '').trim(), 220) ||
        fallback?.summary ||
        `第 ${index + 1} 集剧情摘要。`,
      hook:
        truncateHead(String(raw.hook || '').trim(), 100) ||
        fallback?.hook ||
        `第 ${index + 1} 集在结尾制造新的悬念。`,
      focus:
        truncateHead(String(raw.focus || '').trim(), 140) || fallback?.focus || '推进主线冲突。',
      sourceSectionIds: rawIds.length > 0 ? rawIds : fallback?.sourceSectionIds || [],
    } satisfies EpisodePlan;
  });

  // 整体覆盖校验：集数必须与目标一致，且各集片段严格递增、不重叠、覆盖全部节点
  if (plans.length !== episodeCount) {
    return fallbackPlans;
  }
  const allReferenced = dedupeStrings(plans.flatMap((plan) => plan.sourceSectionIds));
  if (allReferenced.length !== validIds.size) {
    return fallbackPlans;
  }
  let maxSeenOrder = 0;
  for (const plan of plans) {
    if (plan.sourceSectionIds.length === 0) {
      return fallbackPlans;
    }
    const firstOrder = orderById.get(plan.sourceSectionIds[0]) || 0;
    const lastOrder = orderById.get(plan.sourceSectionIds[plan.sourceSectionIds.length - 1]) || 0;
    if (firstOrder < maxSeenOrder) {
      return fallbackPlans;
    }
    maxSeenOrder = Math.max(maxSeenOrder, lastOrder);
  }
  return plans;
};

/** 把规划结果中高层节点的 sourceSectionIds 展开回原始片段 id（按原始片段顺序排序） */
export const expandSourceSectionIds = (
  plans: EpisodePlan[],
  topNodes: SectionSummary[],
  baseSections: ReadonlyArray<{ id: string; order: number }>
): EpisodePlan[] => {
  const topNodeById = new Map(topNodes.map((node) => [node.id, node]));
  const orderById = new Map(baseSections.map((node) => [node.id, node.order]));
  return plans.map((plan) => {
    const expanded = dedupeStrings(
      plan.sourceSectionIds.flatMap((id) => topNodeById.get(id)?.sourceSectionIds || [])
    ).sort((a, b) => (orderById.get(a) || 0) - (orderById.get(b) || 0));
    return {
      ...plan,
      sourceSectionIds: expanded.length > 0 ? expanded : plan.sourceSectionIds,
    };
  });
};

/** 分集规划主函数：LLM 规划 + 字段回退，任何失败路径都保证有可用分集结构 */
export const planEpisodes = async (input: PlanningInput): Promise<EpisodePlanningOutcome> => {
  try {
    const raw = await retryOperation(
      () =>
        chatCompletion(
          buildPlanningPrompt({
            projectTitleSuggestion: input.projectTitleSuggestion,
            sectionSummaries: input.sectionSummaries,
            episodeCount: input.episodeCount,
            language: input.language,
            targetDuration: input.targetDuration,
            durationGuide: input.durationGuide,
            preferredSeriesTitle: input.preferredSeriesTitle,
          }),
          input.model,
          0.3,
          4096,
          'json_object',
          300000,
          input.abortSignal
        ),
      2,
      1500,
      input.abortSignal
    );
    const parsed = parseJsonWithRecovery<RawPlanningResult>(raw, {});
    const fallbackDescription =
      truncateHead(input.sectionSummaries.slice(0, 3).map((node) => node.summary).join(' '), 220) ||
      '自动从整篇小说拆分出的分集草稿项目。';
    return {
      projectTitle:
        truncateHead(String(parsed.projectTitle || '').trim(), 48) ||
        truncateHead(input.projectTitleSuggestion, 48) ||
        '小说改编项目',
      projectDescription:
        truncateHead(String(parsed.projectDescription || '').trim(), 220) || fallbackDescription,
      seriesTitle:
        truncateHead(String(parsed.seriesTitle || '').trim(), 32) ||
        truncateHead(input.preferredSeriesTitle || '', 32) ||
        '第一季',
      episodes: normalizeEpisodePlans(parsed.episodes, input.sectionSummaries, input.episodeCount),
    };
  } catch {
    return {
      projectTitle: truncateHead(input.projectTitleSuggestion, 48) || '小说改编项目',
      projectDescription:
        truncateHead(input.sectionSummaries.slice(0, 3).map((node) => node.summary).join(' '), 220) ||
        '自动从整篇小说拆分出的分集草稿项目。',
      seriesTitle: truncateHead(input.preferredSeriesTitle || '', 32) || '第一季',
      episodes: splitNodesEvenly(input.sectionSummaries, input.episodeCount),
    };
  }
};
