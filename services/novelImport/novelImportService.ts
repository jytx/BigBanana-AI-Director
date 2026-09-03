/**
 * 小说导入主编排
 *
 * 完整流水线：清洗校验 → 两阶段切分 → 并发摘要 → 多层压缩 →
 * 分集规划 → id 回展开 → 串行草稿生成。
 * 行为对齐官方 studio 版 generateNovelImportResult
 * （反混淆产物 deob-novel/deobfuscated.js）。
 */

import { getActiveChatModel } from '../ai/apiCore';
import { compressSummariesIfNeeded } from './compressor';
import { writeEpisodeDraft } from './draftWriter';
import { expandSourceSectionIds, planEpisodes } from './planner';
import { summarizeSection } from './summarizer';
import {
  clampNumber,
  COARSE_SECTION_BUDGET_CHARS,
  estimateEpisodeCount,
  MAX_EPISODE_COUNT,
  MAX_NOVEL_LENGTH,
  resolveDurationProfile,
  runWithConcurrency,
  sanitizeNovelText,
  splitNovelIntoSections,
  throwIfAborted,
  truncateHead,
} from './sectioning';
import {
  EpisodeDraft,
  EpisodePlan,
  LlmCallContext,
  NovelImportInput,
  NovelImportResult,
  SectionSummary,
} from './types';

/** 超长正文的错误提示（附带当前字数） */
export const buildOverlongMessage = (charCount: number): string => {
  const prefix =
    typeof charCount === 'number' && Number.isFinite(charCount) && charCount > MAX_NOVEL_LENGTH
      ? `当前内容约 ${charCount.toLocaleString('zh-CN')} 字，`
      : '';
  return `${prefix}导入小说暂时限制在 5 万字以内。建议先在剧本里按“一章节做一集”分批导入，一次性内容太多会影响模型处理效果。`;
};

/** 从正文中挑一行不超过 40 字的非空文本作为项目标题建议 */
const pickProjectTitleSuggestion = (cleanedNovel: string): string =>
  truncateHead(
    cleanedNovel
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.length <= 40) || '',
    40
  ) || '小说改编项目';

/** 为第一层摘要挂上回溯 id（进入压缩层前，每个摘要节点指向自身片段） */
const attachSelfReference = (summaries: SectionSummary[]): SectionSummary[] =>
  summaries.map((summary) => ({ ...summary, sourceSectionIds: [summary.id] }));

/**
 * 小说导入主入口：输入正文与偏好，输出系列信息与逐集草稿。
 * 任一阶段的中断信号触发即抛出 Request cancelled。
 */
export const generateNovelImportResult = async (input: NovelImportInput): Promise<NovelImportResult> => {
  const cleanedNovel = sanitizeNovelText(input.rawNovel);
  if (cleanedNovel === '') {
    throw new Error('请先输入小说正文。');
  }
  if (cleanedNovel.length > MAX_NOVEL_LENGTH) {
    throw new Error(buildOverlongMessage(cleanedNovel.length));
  }

  const ctx: LlmCallContext = {
    model: input.model || getActiveChatModel()?.id || 'gpt-5.4',
    language: String(input.language || '中文').trim() || '中文',
    abortSignal: input.abortSignal,
  };
  const targetDuration = String(input.targetDuration || '60s').trim() || '60s';
  const profile = resolveDurationProfile(targetDuration);
  const desiredCount =
    input.desiredEpisodeCount == null
      ? null
      : clampNumber(Math.round(Number(input.desiredEpisodeCount) || 1), 1, MAX_EPISODE_COUNT);

  const report = (message: string): void => {
    if (input.onProgress != null) {
      input.onProgress(message);
    }
  };
  report('正在整理小说结构...');
  throwIfAborted(input.abortSignal);

  // 第一阶段粗切分（6000 字/段）：仅用于集数估算
  const coarseSections = splitNovelIntoSections(cleanedNovel, COARSE_SECTION_BUDGET_CHARS);
  const episodeCount =
    desiredCount != null
      ? desiredCount
      : estimateEpisodeCount(cleanedNovel.length, coarseSections.length, profile);

  // 第二阶段精切分：预算自适应（随集数与节点上限在 2800-7000 字间收缩）
  const summaryNodeLimit = clampNumber(episodeCount * 2, 8, 24);
  const sectionBudget = clampNumber(
    Math.ceil(cleanedNovel.length / clampNumber(summaryNodeLimit * 3, 12, 96)),
    2800,
    7000
  );
  const sections = splitNovelIntoSections(cleanedNovel, sectionBudget);
  if (sections.length === 0) {
    throw new Error('未能从小说内容中识别出可拆分的剧情片段，请检查文本格式后重试。');
  }
  report(`已整理出 ${sections.length} 个剧情片段，正在提炼关键脉络...`);
  throwIfAborted(input.abortSignal);

  // 片段摘要：并发 2，逐段报告进度
  const sectionSummaries = await runWithConcurrency(sections, 2, async (section, index) => {
    throwIfAborted(input.abortSignal);
    report(`正在提炼片段 ${index + 1}/${sections.length}：${section.title}`);
    return summarizeSection(section, ctx);
  });

  // 多层压缩：摘要节点收敛到规划上限以内
  const topNodes = await compressSummariesIfNeeded({
    ...ctx,
    nodes: attachSelfReference(sectionSummaries),
    maxNodeCount: summaryNodeLimit,
    onProgress: input.onProgress,
  });

  const projectTitleSuggestion = pickProjectTitleSuggestion(cleanedNovel);
  report(`已整理出 ${topNodes.length} 个可规划剧情节点，正在规划 ${episodeCount} 集的分集结构...`);
  throwIfAborted(input.abortSignal);

  // 分集规划 + 高层节点 id 回展开为原始片段 id
  const planning = await planEpisodes({
    ...ctx,
    projectTitleSuggestion,
    sectionSummaries: topNodes,
    episodeCount,
    targetDuration,
    durationGuide: profile.pacing,
    preferredSeriesTitle: String(input.seriesTitle || '').trim(),
  });
  const episodePlans = expandSourceSectionIds(planning.episodes, topNodes, sections);

  // 逐集草稿：串行执行（下一集的连续性上下文依赖上一集草稿）
  const drafts: EpisodeDraft[] = [];
  for (let index = 0; index < episodePlans.length; index += 1) {
    throwIfAborted(input.abortSignal);
    const currentPlan: EpisodePlan = episodePlans[index];
    report(`正在生成第 ${index + 1}/${episodePlans.length} 集草稿：${currentPlan.title}`);
    const draft = await writeEpisodeDraft({
      ...ctx,
      episode: currentPlan,
      sections,
      sectionSummaries,
      previousEpisodeDraft: index > 0 ? drafts[index - 1] : null,
      previousEpisodePlan: index > 0 ? episodePlans[index - 1] : null,
      nextEpisodePlan: index + 1 < episodePlans.length ? episodePlans[index + 1] : null,
      targetDuration,
      draftRange: profile.draftRange,
      pacingGuide: profile.pacing,
      projectTitle: planning.projectTitle,
    });
    drafts.push(draft);
  }
  if (drafts.length === 0) {
    throw new Error('未能生成任何分集草稿，请尝试缩短小说内容或减少目标集数。');
  }
  report(`已完成 ${drafts.length} 集草稿生成。`);

  return {
    projectTitle: planning.projectTitle,
    projectDescription: planning.projectDescription,
    seriesTitle: planning.seriesTitle,
    episodes: drafts,
    model: ctx.model,
    language: ctx.language,
    targetDuration,
    sourceSectionCount: sections.length,
  };
};
