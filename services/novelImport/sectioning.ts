/**
 * 小说切分与时长档案（纯函数层）
 * 职责：文本清洗、时长档案（预设 + 插值）、章节/段落切分、预算聚合、集数预估，
 * 以及供各 LLM 层复用的通用工具（截断/去重/并发池/中断检查）。
 * 行为对齐官方 studio 版（反混淆产物 deob-novel/deobfuscated.js）。
 */

import { parseDurationToSeconds } from '../durationParser';
import { DurationProfile, NovelSection } from './types';

/** 单次导入的最大集数 */
export const MAX_EPISODE_COUNT = 24;
/** 小说正文字符硬上限（官方限制 5 万字） */
export const MAX_NOVEL_LENGTH = 50000;
/** 粗切分阶段每段字符预算（仅用于集数估算） */
export const COARSE_SECTION_BUDGET_CHARS = 6000;

/** 章节标题行匹配：第X章/节/回/卷/部/篇/集、Chapter N、序章/楔子/前言/尾声/番外/后记 */
const CHAPTER_TITLE_PATTERN =  /^(?:第[\d一二三四五六七八九十百千万零两〇]+[章节回卷部篇集]|chapter\s+\d+|chapter\s+[ivxlcdm]+|prologue|epilogue|preface|序章|楔子|前言|尾声|番外|后记)/iu;

/** 时长插值锚点（预设秒数处的档案基准值） */
interface DurationProfileAnchor {
  seconds: number;
  sourceCharsPerEpisode: number;
  sectionsPerEpisode: number;
  draftMin: number;
  draftMax: number;
}

const DURATION_ANCHORS: DurationProfileAnchor[] = [
  { seconds: 30, sourceCharsPerEpisode: 4500, sectionsPerEpisode: 1.2, draftMin: 1200, draftMax: 1800 },
  { seconds: 60, sourceCharsPerEpisode: 7500, sectionsPerEpisode: 2, draftMin: 2200, draftMax: 3200 },
  { seconds: 120, sourceCharsPerEpisode: 13000, sectionsPerEpisode: 3.5, draftMin: 3600, draftMax: 5200 },
  { seconds: 300, sourceCharsPerEpisode: 22000, sectionsPerEpisode: 6, draftMin: 6500, draftMax: 9000 },
];

/** 预设时长档案快照（与官方下拉选项一一对应） */
const PRESET_PROFILES: Record<string, DurationProfile> = {
  '30s': { sourceCharsPerEpisode: 4500, sectionsPerEpisode: 1.2, draftRange: '1200-1800 字', pacing: '极快节奏，集中在单一冲突、反转和钩子结尾。' },
  '60s': { sourceCharsPerEpisode: 7500, sectionsPerEpisode: 2, draftRange: '2200-3200 字', pacing: '快节奏，适合 4-6 个场景，结尾要有明显悬念。' },
  '120s': { sourceCharsPerEpisode: 13000, sectionsPerEpisode: 3.5, draftRange: '3600-5200 字', pacing: '中快节奏，适合 6-8 个场景，有完整起承转合。' },
  '300s': { sourceCharsPerEpisode: 22000, sectionsPerEpisode: 6, draftRange: '6500-9000 字', pacing: '允许更完整的人物推进和情绪铺垫，但仍然需要分集钩子。' },
};

/** 清洗小说正文：统一换行、去空字节、压缩连续空行、去首尾空白 */
export const sanitizeNovelText = (raw: string): string =>
  String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** 数值夹取 */
export const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** 头部截断：超长时保留前 limit-1 字符并以省略号结尾 */
export const truncateHead = (text: string, limit: number): string => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
};

/** 尾部截断：超长时保留最后 limit-1 字符并在开头加省略号（用于"结尾片段"类引用） */
export const truncateTail = (text: string, limit: number): string => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `…${normalized.slice(Math.max(0, normalized.length - limit + 1)).trim()}`;
};

/** 保序去重字符串列表 */
export const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
};

/** 若信号已中断则抛出取消异常 */
export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal != null && signal.aborted) {
    throw new Error('Request cancelled');
  }
};

/** 固定并发度的顺序保持执行池：结果写回原下标，全部完成后按原顺序返回 */
export const runWithConcurrency = async <TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>
): Promise<TResult[]> => {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
};

/** 数值向上取整到指定步长 */
const roundUpToStep = (value: number, step: number): number => Math.max(step, Math.round(value / step) * step);

/** 在锚点表上按秒数线性插值指定字段 */
const interpolateAnchorValue = (
  seconds: number,
  key: 'sourceCharsPerEpisode' | 'sectionsPerEpisode' | 'draftMin' | 'draftMax'
): number => {
  const first = DURATION_ANCHORS[0];
  const last = DURATION_ANCHORS[DURATION_ANCHORS.length - 1];
  if (seconds <= first.seconds) {
    return first[key] * Math.max(0.35, seconds / first.seconds);
  }
  if (seconds >= last.seconds) {
    return last[key] * (seconds / last.seconds);
  }
  for (let i = 0; i < DURATION_ANCHORS.length - 1; i += 1) {
    const lower = DURATION_ANCHORS[i];
    const upper = DURATION_ANCHORS[i + 1];
    if (seconds >= lower.seconds && seconds <= upper.seconds) {
      const ratio = (seconds - lower.seconds) / (upper.seconds - lower.seconds);
      return lower[key] + (upper[key] - lower[key]) * ratio;
    }
  }
  return last[key];
};

/** 按单集秒数生成节奏要求描述 */
const buildPacingGuide = (seconds: number): string => {
  if (seconds <= 45) return '极快节奏，聚焦单一冲突、快速反转和强钩子结尾。';
  if (seconds <= 90) return '快节奏，建议尽快进入核心冲突，并在结尾保留明显悬念。';
  if (seconds <= 180) return '中快节奏，适合完整起承转合，并保留一处明显情绪或剧情推进。';
  if (seconds <= 360) return '中等节奏，可以容纳更完整的人物推进和情绪铺垫，但每集仍需清晰钩子。';
  return '长时长节奏，允许更充分的人物关系与世界观展开，同时每集仍需持续推进。';
};

/** 由秒数插值生成完整时长档案 */
const buildInterpolatedProfile = (seconds: number): DurationProfile => {
  const normalizedSeconds = Math.max(15, Math.round(seconds));
  const draftMin = roundUpToStep(interpolateAnchorValue(normalizedSeconds, 'draftMin'), 100);
  const draftMax = Math.max(draftMin + 200, roundUpToStep(interpolateAnchorValue(normalizedSeconds, 'draftMax'), 100));
  return {
    sourceCharsPerEpisode: roundUpToStep(interpolateAnchorValue(normalizedSeconds, 'sourceCharsPerEpisode'), 100),
    sectionsPerEpisode: Number(interpolateAnchorValue(normalizedSeconds, 'sectionsPerEpisode').toFixed(1)),
    draftRange: `${draftMin}-${draftMax} 字`,
    pacing: buildPacingGuide(normalizedSeconds),
  };
};

/** 解析时长字符串为档案：优先预设快照，其次秒数插值，无法解析时回退 60s 预设 */
export const resolveDurationProfile = (duration: string): DurationProfile => {
  const key = String(duration || '').trim();
  const preset = PRESET_PROFILES[key];
  if (preset) {
    return preset;
  }
  const seconds = parseDurationToSeconds(key);
  if (seconds === null) {
    return PRESET_PROFILES['60s'];
  }
  return buildInterpolatedProfile(seconds);
};

/** 按空行切出非空段落块 */
const splitIntoParagraphBlocks = (text: string): string[] =>
  String(text || '')
    .split(/\n{2,}/g)
    .map((block) => block.trim())
    .filter((block) => block !== '');

/** 生成片段 id：section-{index+1} */
const makeSectionId = (index: number): string => `section-${index + 1}`;

/** 生成压缩层节点 id：summary-l{layer}-group-{index+1} */
export const makeCompressionNodeId = (layer: number, groupIndex: number): string =>
  `summary-l${layer}-group-${groupIndex + 1}`;

/** 为无元信息的片段补齐 id 与 order */
const assignSectionMeta = (sections: Array<{ title: string; content: string }>): NovelSection[] =>
  sections.map((section, index) => ({
    title: section.title,
    content: section.content,
    id: makeSectionId(index),
    order: index + 1,
  }));

/** 将段落块按字符预算聚合成段（超出预算即收口，标题冲突时以（续）后缀区分） */
const aggregateParagraphsWithBudget = (
  paragraphs: string[],
  budgetChars: number,
  fallbackTitle: string
): Array<{ title: string; content: string }> => {
  const sections: Array<{ title: string; content: string }> = [];
  let buffer: string[] = [];
  let bufferedChars = 0;
  const flush = () => {
    if (buffer.length !== 0) {
      sections.push({
        title: sections.length === 0 ? fallbackTitle : `${fallbackTitle}（续）`,
        content: buffer.join('\n\n'),
      });
      buffer = [];
      bufferedChars = 0;
    }
  };
  for (const paragraph of paragraphs) {
    const mergedChars = bufferedChars + paragraph.length + (buffer.length > 0 ? 2 : 0);
    if (buffer.length > 0 && mergedChars > budgetChars) {
      flush();
    }
    buffer.push(paragraph);
    bufferedChars += paragraph.length + (buffer.length > 1 ? 2 : 0);
  }
  flush();
  return sections;
};

/** 单段内容超预算时再切分为（1/N）编号的多个片段 */
const splitOversizedContent = (
  title: string,
  content: string,
  budgetChars: number
): Array<{ title: string; content: string }> => {
  const paragraphs = splitIntoParagraphBlocks(content);
  if (paragraphs.length <= 1 && content.length <= budgetChars) {
    return [{ title, content: content.trim() }];
  }
  if (paragraphs.length === 0) {
    return [{ title, content: content.trim() }];
  }
  const aggregated = aggregateParagraphsWithBudget(paragraphs, budgetChars, title);
  return aggregated.map((piece, index) => ({
    title: aggregated.length > 1 ? `${title}（${index + 1}/${aggregated.length}）` : title,
    content: piece.content,
  }));
};

/** 小说正文切分主入口：按章节标题行切分（超预算二次切分）；无章节标题时按空行分段 + 预算聚合 */
export const splitNovelIntoSections = (rawNovel: string, budgetChars: number): NovelSection[] => {
  const lines = rawNovel.split('\n');
  const sections: Array<{ title: string; content: string }> = [];
  let sawChapterTitle = false;
  let currentTitle = '开篇';
  let contentLines: string[] = [];
  const flush = () => {
    const joined = contentLines.join('\n').trim();
    if (joined !== '') {
      sections.push(...splitOversizedContent(currentTitle, joined, budgetChars));
    }
  };
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (CHAPTER_TITLE_PATTERN.test(trimmedLine)) {
      sawChapterTitle = true;
      flush();
      currentTitle = trimmedLine;
      contentLines = [];
      continue;
    }
    contentLines.push(line);
  }
  flush();
  if (sawChapterTitle) {
    return assignSectionMeta(sections);
  }
  return assignSectionMeta(aggregateParagraphsWithBudget(splitIntoParagraphBlocks(rawNovel), budgetChars, '正文'));
};

/** 集数预估：按字符量与段数两个维度取上界，再夹取 1-24 */
export const estimateEpisodeCount = (  totalChars: number,
  sectionCount: number,
  profile: DurationProfile
): number =>
  clampNumber(
    Math.max(
      Math.ceil(totalChars / profile.sourceCharsPerEpisode),
      Math.ceil(sectionCount / profile.sectionsPerEpisode)
    ),
    1,
    MAX_EPISODE_COUNT
  );
