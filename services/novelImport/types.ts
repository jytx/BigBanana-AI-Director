/**
 * 小说导入功能类型定义
 *
 * 行为规格对齐官方 studio 版 novelImportService
 * （参考：discuss/功能演进迁移方案.md 第二节、反混淆产物 deob-novel/deobfuscated.js）
 */

/** 从小说正文中切分出的剧情片段（第一层结构） */
export interface NovelSection {
  /** 片段唯一标识，形如 section-1 */
  id: string;
  /** 在全文中的顺序（从 1 开始） */
  order: number;
  /** 片段标题（通常为章节名，或聚合段落的回退标题） */
  title: string;
  /** 片段正文内容 */
  content: string;
}

/**
 * 剧情摘要节点：既承载第一层的片段摘要，
 * 也承载多层压缩后的高层剧情阶段（此时 sourceSectionIds 指向更深层节点 id）
 */
export interface SectionSummary {
  /** 节点唯一标识：第一层与片段一致，压缩层形如 summary-l1-group-2 */
  id: string;
  /** 节点顺序（从 1 开始） */
  order: number;
  title: string;
  /** 80-220 字剧情摘要 */
  summary: string;
  /** 关键事件列表（2-6 条） */
  keyEvents: string[];
  /** 涉及的核心角色名列表 */
  characters: string[];
  /** 悬念/转折钩子描述 */
  hook: string;
  /** 该节点回溯到的下一层节点 id 列表 */
  sourceSectionIds: string[];
}

/** 分集规划结果（规划阶段产物，尚未生成草稿正文） */
export interface EpisodePlan {
  /** 集数编号（1-24） */
  episodeNumber: number;
  title: string;
  summary: string;
  /** 本集结尾悬念 */
  hook: string;
  /** 本集最重要的戏剧目标 */
  focus: string;
  /** 本集引用的原始片段 id 列表（已按原文顺序排序） */
  sourceSectionIds: string[];
}

/** 单集创作草稿（最终交付形态） */
export interface EpisodeDraft {
  episodeNumber: number;
  title: string;
  summary: string;
  hook: string;
  /** 可直接进入后续创作流程的剧本草稿正文（场景标题 + 动作/对白格式） */
  rawScript: string;
  sourceSectionIds: string[];
}

/** 单集目标时长档案：决定每集源字符量 / 段数 / 草稿长度 / 节奏提示 */
export interface DurationProfile {
  /** 每集消耗的原文字符量（用于集数预估） */
  sourceCharsPerEpisode: number;
  /** 每集覆盖的剧情段数（用于集数预估） */
  sectionsPerEpisode: number;
  /** 草稿建议长度区间（展示用文案） */
  draftRange: string;
  /** 节奏要求提示（注入分集与草稿提示词） */
  pacing: string;
}

/** 小说导入的原始输入（除正文外均可选，由主编排归一化） */
export interface NovelImportInput {
  /** 小说正文（粘贴或文件读取内容） */
  rawNovel: string;
  /** 指定模型 id；缺省时使用当前激活的 chat 模型 */
  model?: string;
  /** 输出语言；缺省为「中文」 */
  language?: string;
  /** 单集目标时长；预设 30s/60s/120s/300s，也接受 90s/3m/2m30s/2:30；缺省 60s */
  targetDuration?: string;
  /** 期望集数（1-24）；缺省时按篇幅自动拆分 */
  desiredEpisodeCount?: number;
  /** 候选剧集名；缺省时由模型自行拟定 */
  seriesTitle?: string;
  /** 中断信号 */
  abortSignal?: AbortSignal;
  /** 进度回调（界面实时展示） */
  onProgress?: (message: string) => void;
}

/** 小说导入最终结果 */
export interface NovelImportResult {
  projectTitle: string;
  projectDescription: string;
  seriesTitle: string;
  episodes: EpisodeDraft[];
  /** 实际使用的模型 id */
  model: string;
  language: string;
  targetDuration: string;
  /** 初始切分出的剧情片段总数 */
  sourceSectionCount: number;
}

/** 各 LLM 阶段共享的调用上下文（由主编排归一化后逐层传递） */
export interface LlmCallContext {
  model: string;
  language: string;
  abortSignal: AbortSignal | undefined;
}

/** 分集规划阶段的产出结构 */
export interface EpisodePlanningOutcome {
  projectTitle: string;
  projectDescription: string;
  seriesTitle: string;
  episodes: EpisodePlan[];
}
