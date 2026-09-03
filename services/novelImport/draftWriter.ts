/**
 * 单集草稿层：把分集规划改写为可进入创作流程的剧本草稿
 *
 * 逐集串行执行（下一集的连续性上下文依赖上一集草稿结果）。
 * 主路径为 LLM 改写（短剧编剧提示词），失败时降级为
 * 素材拼接（场景N：标题 + 摘要 + 关键事件），保证每集都有正文产出。
 */

import { chatCompletion, parseJsonWithRecovery, retryOperation } from '../ai/apiCore';
import { buildContinuityContext, buildDraftPrompt, buildSourceMaterial } from './prompts';
import { truncateHead } from './sectioning';
import { EpisodeDraft, EpisodePlan, LlmCallContext, NovelSection, SectionSummary } from './types';

/** LLM 草稿结果的最小结构 */
interface RawDraftResult {
  title?: unknown;
  summary?: unknown;
  rawScript?: unknown;
}

/** 草稿生成完整入参 */
export interface DraftWriterInput extends LlmCallContext {
  /** 本集规划 */
  episode: EpisodePlan;
  /** 原始片段列表（取原文素材用） */
  sections: NovelSection[];
  /** 第一层片段摘要（素材组装与连续性上下文用） */
  sectionSummaries: SectionSummary[];
  /** 上一集已生成草稿（首集为 null） */
  previousEpisodeDraft: EpisodeDraft | null;
  /** 上一集规划（首集为 null） */
  previousEpisodePlan: EpisodePlan | null;
  /** 下一集规划（末集为 null） */
  nextEpisodePlan: EpisodePlan | null;
  targetDuration: string;
  /** 时长档案（草稿长度区间与节奏提示注入提示词） */
  draftRange: string;
  pacingGuide: string;
  projectTitle: string;
}

/** 降级草稿：把本集相关摘要拼成「场景 N：标题 + 摘要 + 关键事件」的纯文本 */
export const buildFallbackDraft = (relatedSummaries: SectionSummary[]): string =>
  relatedSummaries
    .map((summary, index) => {
      const eventLines = summary.keyEvents.slice(0, 3).map((event) => `- ${event}`).join('\n');
      return [`场景 ${index + 1}：${summary.title}`, summary.summary, eventLines]
        .filter((line) => line !== '')
        .join('\n');
    })
    .join('\n\n');

/** 单集草稿生成：素材组装 → 连续性上下文 → LLM 改写 → 字段回退 */
export const writeEpisodeDraft = async (input: DraftWriterInput): Promise<EpisodeDraft> => {
  const relatedSummaries = input.sectionSummaries.filter((summary) =>
    input.episode.sourceSectionIds.includes(summary.id)
  );
  const fallbackDraft = buildFallbackDraft(relatedSummaries);
  const sourceMaterial = buildSourceMaterial(
    input.sections,
    input.sectionSummaries,
    input.episode.sourceSectionIds,
    18000
  );
  const continuityContext = buildContinuityContext({
    episode: input.episode,
    relatedSummaries,
    previousEpisodeDraft: input.previousEpisodeDraft,
    previousEpisodePlan: input.previousEpisodePlan,
    nextEpisodePlan: input.nextEpisodePlan,
  });
  try {
    const raw = await retryOperation(
      () =>
        chatCompletion(
          buildDraftPrompt({
            episode: input.episode,
            sourceMaterial,
            continuityContext,
            language: input.language,
            targetDuration: input.targetDuration,
            draftRange: input.draftRange,
            pacingGuide: input.pacingGuide,
            projectTitle: input.projectTitle,
          }),
          input.model,
          0.45,
          4096,
          'json_object',
          300000,
          input.abortSignal
        ),
      2,
      1500,
      input.abortSignal
    );
    const parsed = parseJsonWithRecovery<RawDraftResult>(raw, {});
    return {
      episodeNumber: input.episode.episodeNumber,
      title: truncateHead(String(parsed.title || '').trim(), 48) || input.episode.title,
      summary: truncateHead(String(parsed.summary || '').trim(), 200) || input.episode.summary,
      hook: input.episode.hook,
      rawScript: String(parsed.rawScript || '').trim() || fallbackDraft,
      sourceSectionIds: input.episode.sourceSectionIds,
    };
  } catch {
    return {
      episodeNumber: input.episode.episodeNumber,
      title: input.episode.title,
      summary: input.episode.summary,
      hook: input.episode.hook,
      rawScript: fallbackDraft,
      sourceSectionIds: input.episode.sourceSectionIds,
    };
  }
};
