/**
 * 小说导入提示词模板（纯模板函数层）
 *
 * 承载四段核心提示词（片段摘要 / 多层压缩 / 分集规划 / 单集草稿）
 * 以及连续性上下文与原文素材的组装逻辑。
 * 文案逐段对齐官方 studio 版（反混淆产物 deob-novel/deobfuscated.js）。
 */

import {
  EpisodePlan,
  EpisodeDraft,
  NovelSection,
  SectionSummary,
} from './types';
import { truncateHead, truncateTail } from './sectioning';

/** 将摘要节点列表渲染为提示词用的文本块（供压缩/规划阶段引用） */
export const formatSummariesForPrompt = (nodes: SectionSummary[]): string =>
  nodes
    .map((node) => {
      const keyEventLines = node.keyEvents.map((event) => `- ${event}`).join('\n');
      const characterLine = node.characters.length > 0 ? node.characters.join('、') : '未特别指明';
      return [
        `Node ID: ${node.id}`,
        `标题: ${node.title}`,
        `摘要: ${node.summary}`,
        '关键事件:',
        keyEventLines || '- 无',
        `涉及角色: ${characterLine}`,
        `钩子: ${node.hook || '无'}`,
      ].join('\n');
    })
    .join('\n\n');

/** 片段摘要提示词：把小说片段提炼成「分集规划」可用的摘要 */
export const buildSectionSummaryPrompt = (section: NovelSection, language: string): string =>
  (
    `\n你是一个小说拆分助手。请把下面这个小说片段提炼成后续“分集规划”可用的摘要。\n\n输出语言：${language}\n\n请输出严格 JSON：\n{\n  "summary": "80-180字，说明这一段发生了什么",\n  "keyEvents": ["事件1", "事件2", "事件3"],\n  "characters": ["角色A", "角色B"],\n  "hook": "这一段最适合作为悬念或转折的点"\n}\n\n要求：\n- 摘要必须保留因果关系，不要只罗列名词。\n- "keyEvents" 保留 2-5 个最关键动作或信息。\n- "characters" 只保留核心人物姓名，没有就返回空数组。\n- "hook" 尽量指出最能做分集收尾的转折点。\n\n片段标题：${section.title}\n片段内容：\n${section.content}\n`
  ).trim();

/** 多层压缩提示词：把一组按序摘要节点压缩成更高层的剧情阶段摘要 */
export const buildCompressionPrompt = (input: {
  nodes: SectionSummary[];
  layer: number;
  language: string;
}): string =>
  (
    `\n你是小说结构编辑助手。下面给出的是一组按原文顺序排列的剧情摘要节点，请把它们压缩成一个更高层的剧情阶段摘要，供后续分集规划使用。\n\n输出语言：${input.language}\n当前压缩层级：第 ${input.layer} 层\n\n请输出严格 JSON：\n{\n  "title": "这个剧情阶段的短标题",\n  "summary": "100-220字，概括这一组剧情如何推进",\n  "keyEvents": ["事件1", "事件2", "事件3"],\n  "characters": ["角色A", "角色B"],\n  "hook": "这一组剧情最适合做阶段收尾悬念的点"\n}\n\n要求：\n- 必须保持给定节点的原始顺序，不要改写时间线。\n- "summary" 要覆盖这组剧情的起点、推进和阶段性结果，保留因果关系。\n- "keyEvents" 保留 3-6 个最关键的阶段事件。\n- "characters" 只保留反复影响剧情的核心人物。\n- "hook" 优先提炼这组剧情最后最适合作为转折或悬念的点。\n\n待压缩节点：\n${formatSummariesForPrompt(input.nodes)}\n`
  ).trim();

/** 分集规划提示词：把长篇小说拆成适合短剧创作流程的分集草稿结构 */
export const buildPlanningPrompt = (input: {
  projectTitleSuggestion: string;
  sectionSummaries: SectionSummary[];
  episodeCount: number;
  language: string;
  targetDuration: string;
  durationGuide: string;
  preferredSeriesTitle: string;
}): string =>
  (
    `\n你是资深小说改编策划，需要把一部长篇小说拆成适合短剧/视频创作流程的分集草稿。\n\n输出语言：${input.language}\n单集目标时长：${input.targetDuration}\n节奏要求：${input.durationGuide}\n目标集数：${input.episodeCount}\n候选系列名：${input.preferredSeriesTitle || '未提供，请自行生成'}\n\n请基于下面的分段摘要，输出严格 JSON：\n{\n  "projectTitle": "项目/小说标题",\n  "projectDescription": "80-180字，说明整部作品主线、卖点和改编方向",\n  "seriesTitle": "本次导入使用的剧集名称",\n  "episodes": [\n    {\n      "episodeNumber": 1,\n      "title": "分集标题",\n      "summary": "本集剧情摘要",\n      "hook": "本集结尾悬念",\n      "focus": "本集最重要的戏剧目标",\n      "sourceSectionIds": ["node-1", "node-2"]\n    }\n  ]\n}\n\n硬性要求：\n- 必须返回恰好 ${input.episodeCount} 集。\n- "sourceSectionIds" 只能使用给定的剧情节点 id。\n- 分集必须按照原文顺序推进，不允许打乱时间线。\n- 每集都要有清晰的开场任务、冲突升级和结尾钩子。\n- 要覆盖整部小说的关键节点，不要把重要高潮全部堆到最后一集。\n- 标题要有传播感，但不能脱离剧情。\n\n小说标题参考：${input.projectTitleSuggestion}\n\n可用分段摘要：\n${formatSummariesForPrompt(input.sectionSummaries)}\n`
  ).trim();

/** 连续性上下文：约束草稿开场承接上集、结尾递进下集 */
export const buildContinuityContext = (input: {
  episode: EpisodePlan;
  relatedSummaries: SectionSummary[];
  previousEpisodeDraft: EpisodeDraft | null;
  previousEpisodePlan: EpisodePlan | null;
  nextEpisodePlan: EpisodePlan | null;
}): string => {
  const openingSummary = input.relatedSummaries[0];
  const closingSummary = input.relatedSummaries[input.relatedSummaries.length - 1];
  const previousTail = input.previousEpisodeDraft?.rawScript;
  const lines: string[] = [
    '连续性要求：',
    '- 开场必须先承接上一集结尾状态，不能像重开一个新故事。',
    '- 如果上一集留下悬念、目标或关系冲突，本集前 1-2 个场景要先回应。',
    '- 本集结尾要把冲突自然递交给下一集，避免生硬切断。',
  ];
  if (input.previousEpisodeDraft != null && input.previousEpisodeDraft.summary !== '') {
    lines.push(`上一集已生成摘要：${input.previousEpisodeDraft.summary}`);
  }
  if (input.previousEpisodePlan != null && input.previousEpisodePlan.hook !== '') {
    lines.push(`上一集结尾悬念：${input.previousEpisodePlan.hook}`);
  }
  if (previousTail != null && previousTail !== '') {
    lines.push(`上一集结尾片段参考：${truncateTail(previousTail, 600)}`);
  }
  if (openingSummary != null) {
    lines.push(`本集开场素材重点：${openingSummary.summary}`);
  }
  if (closingSummary != null) {
    lines.push(`本集结尾素材重点：${closingSummary.hook || closingSummary.summary}`);
  }
  if (input.nextEpisodePlan != null) {
    lines.push(`下一集承接方向：${input.nextEpisodePlan.summary}`);
    lines.push(`下一集预埋悬念方向：${input.nextEpisodePlan.hook}`);
  }
  return lines.filter((line) => line !== '').join('\n');
};

/** 原文素材组装：按片段顺序拼装标题/摘要/关键事件/原文，超出字符预算即停止 */
export const buildSourceMaterial = (
  sections: NovelSection[],
  summaries: SectionSummary[],
  sectionIds: string[],
  budgetChars: number
): string => {
  const sectionById = new Map<string, NovelSection>(sections.map((section) => [section.id, section]));
  const summaryById = new Map<string, SectionSummary>(summaries.map((summary) => [summary.id, summary]));
  const blocks: string[] = [];
  let usedChars = 0;
  for (const sectionId of sectionIds) {
    const section = sectionById.get(sectionId);
    if (section == null) {
      continue;
    }
    const summary = summaryById.get(sectionId);
    const keyEvents = summary != null && summary.keyEvents.length > 0 ? `关键事件：${summary.keyEvents.join('；')}` : '';
    const block = [
      `【${section.title}】`,
      summary != null ? `摘要：${summary.summary}` : '',
      keyEvents,
      `原文：${truncateHead(section.content, 7000)}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    if (usedChars > 0 && usedChars + block.length > budgetChars) {
      break;
    }
    blocks.push(block);
    usedChars += block.length;
  }
  return blocks.join('\n\n');
};

/** 单集草稿提示词：把分集素材改写成可直接进入创作流程的剧本草稿 */
export const buildDraftPrompt = (input: {
  episode: EpisodePlan;
  sourceMaterial: string;
  continuityContext: string;
  language: string;
  targetDuration: string;
  draftRange: string;
  pacingGuide: string;
  projectTitle: string;
}): string =>
  (
    `\n你是短剧编剧，请把给定小说素材改写成“单集创作草稿”。\n\n输出语言：${input.language}\n作品名：${input.projectTitle}\n分集标题：${input.episode.title}\n单集目标时长：${input.targetDuration}\n建议成稿长度：${input.draftRange}\n节奏要求：${input.pacingGuide}\n\n请输出严格 JSON：\n{\n  "title": "分集标题",\n  "summary": "80-160字总结本集剧情",\n  "rawScript": "可直接进入后续创作流程的单集草稿正文"\n}\n\n"rawScript" 要求：\n- 输出纯文本剧本草稿，不要写 markdown 标题或列表。\n- 采用“场景标题 + 动作/对白段落”的格式，便于后续自动分析。\n- 场景标题可写成“场景1：……”或“Scene 1: ……”。\n- 对白可写成“角色名：台词”。\n- 必须体现本集的开场目标、冲突升级、高潮和结尾钩子。\n- 开场必须自然承接上一集，不要让人物状态、情绪、目标像被重置。\n- 结尾要给下一集留下自然的接力点，而不是孤立收束。\n- 不要写“待续”“略”等占位词。\n- 内容需要忠于给定素材，但允许为了分集节奏做适度压缩与重组。\n\n本集策划摘要：\n- 剧情摘要：${input.episode.summary}\n- 本集目标：${input.episode.focus}\n- 结尾钩子：${input.episode.hook}\n\n${input.continuityContext}\n\n原始素材：\n${input.sourceMaterial}\n`
  ).trim();
