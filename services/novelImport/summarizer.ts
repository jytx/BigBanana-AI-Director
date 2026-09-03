/**
 * 片段摘要层：为每个剧情片段生成结构化摘要节点
 *
 * 主路径为 LLM 调用（小说拆分助手提示词），
 * 失败时降级为启发式摘要（取段落开头做摘要/关键事件、结尾做钩子），
 * 保证流水线永远有可用产出。
 */

import { chatCompletion, parseJsonWithRecovery, retryOperation } from '../ai/apiCore';
import { buildSectionSummaryPrompt } from './prompts';
import { dedupeStrings, truncateHead } from './sectioning';
import { LlmCallContext, NovelSection, SectionSummary } from './types';

/** LLM 摘要结果的最小结构（keyEvents/characters 缺失时按空数组处理） */
interface RawSectionSummary {
  summary?: unknown;
  keyEvents?: unknown;
  characters?: unknown;
  hook?: unknown;
}

/** 启发式摘要：不依赖 LLM，用片段自身文本拼出可用的摘要节点 */
export const buildHeuristicSummary = (section: NovelSection): SectionSummary => {
  const paragraphs = section.content.split(/\n{2,}/g).map((block) => block.trim()).filter((block) => block !== '');
  const summary = truncateHead(paragraphs.slice(0, 2).join(' '), 180) || truncateHead(section.content, 180);
  const keyEvents = paragraphs.slice(0, 3).map((line) => truncateHead(line, 70)).filter((line) => line !== '');
  const hook = truncateHead(paragraphs[paragraphs.length - 1] || summary || section.title, 80);
  return {
    id: section.id,
    order: section.order,
    title: section.title,
    summary: summary || section.title,
    keyEvents: keyEvents.length > 0 ? keyEvents : [section.title],
    characters: [],
    hook,
    sourceSectionIds: [],
  };
};

/**
 * 单片段摘要：LLM 成功时逐字段清洗回填（摘要 220 / 事件 70×5 / 角色 24×6 / 钩子 100），
 * 任一字段缺失或调用失败均回退到启发式摘要对应字段。
 */
export const summarizeSection = async (
  section: NovelSection,
  ctx: LlmCallContext
): Promise<SectionSummary> => {
  const fallback = buildHeuristicSummary(section);
  try {
    const raw = await retryOperation(
      () =>
        chatCompletion(
          buildSectionSummaryPrompt(section, ctx.language),
          ctx.model,
          0.25,
          1600,
          'json_object',
          300000,
          ctx.abortSignal
        ),
      2,
      1200,
      ctx.abortSignal
    );
    const parsed = parseJsonWithRecovery<RawSectionSummary>(raw, {});
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
      summary: truncateHead(String(parsed.summary || '').trim(), 220) || fallback.summary,
      keyEvents: keyEvents.length > 0 ? keyEvents.slice(0, 5) : fallback.keyEvents,
      characters: characters.length > 0 ? dedupeStrings(characters).slice(0, 6) : fallback.characters,
      hook: truncateHead(String(parsed.hook || '').trim(), 100) || fallback.hook,
    };
  } catch {
    return fallback;
  }
};
