/**
 * 小说导入结果预览面板
 *
 * 展示导入产出的系列信息与逐集草稿（可展开查看草稿正文），
 * 落地动作（创建系列项目）通过回调交给父组件执行。
 */

import React, { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Film, Loader2 } from 'lucide-react';
import { EpisodeDraft, NovelImportResult } from '../../services/novelImport/types';

interface Props {
  /** 导入结果 */
  result: NovelImportResult;
  /** 是否正在创建项目（落地中） */
  isCreating: boolean;
  /** 落地回调：按结果创建系列与全部集 */
  onCreateProject: () => void;
  /** 落地回调：转入「导入到现有项目」选择器 */
  onImportToExisting: () => void;
}

/** 单集草稿卡片：默认收起正文，点击展开 */
const EpisodeCard: React.FC<{ draft: EpisodeDraft; index: number }> = ({ draft, index }) => {
  const [expanded, setExpanded] = useState(false);
  const scriptChars = draft.rawScript.length;
  return (
    <div className="border border-[var(--border-primary)] rounded-lg overflow-hidden bg-[var(--bg-primary)]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-start gap-2 px-4 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 mt-0.5 text-[var(--text-muted)] flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-[var(--text-muted)] font-mono uppercase tracking-widest">
              第 {index + 1} 集
            </span>
            <span className="text-sm font-bold text-[var(--text-primary)] truncate">{draft.title}</span>
            <span className="text-[10px] text-[var(--text-tertiary)] font-mono flex-shrink-0">
              {scriptChars.toLocaleString('zh-CN')} 字
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mt-1 line-clamp-2">{draft.summary}</p>
          {draft.hook !== '' && (
            <p className="text-[11px] text-[var(--text-muted)] mt-1 truncate">钩子：{draft.hook}</p>
          )}
        </div>
      </button>
      {expanded && (
        <pre className="px-4 pb-4 pt-1 text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words border-t border-[var(--border-primary)] bg-[var(--bg-sunken)]">
          {draft.rawScript}
        </pre>
      )}
    </div>
  );
};

/** 结果面板：系列信息汇总 + 分集草稿列表 + 落地操作 */
const NovelImportResultPanel: React.FC<Props> = ({
  result,
  isCreating,
  onCreateProject,
  onImportToExisting,
}) => {
  return (
    <div className="space-y-4">
      <div className="border border-[var(--border-primary)] rounded-xl p-4 bg-[var(--bg-sunken)]">
        <div className="flex items-center gap-2 mb-2">
          <BookOpen className="w-4 h-4 text-[var(--accent-text)]" />
          <span className="text-sm font-bold text-[var(--text-primary)]">{result.projectTitle}</span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{result.projectDescription}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-wider">
          <span>系列：{result.seriesTitle}</span>
          <span>共 {result.episodes.length} 集</span>
          <span>片段 {result.sourceSectionCount} 段</span>
          <span>时长 {result.targetDuration}</span>
          <span>语言 {result.language}</span>
          <span>模型 {result.model}</span>
        </div>
      </div>

      <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
        {result.episodes.map((draft, index) => (
          <EpisodeCard key={draft.episodeNumber} draft={draft} index={index} />
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={onCreateProject}
          disabled={isCreating}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded font-bold text-xs uppercase tracking-widest"
        >
          {isCreating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Film className="w-4 h-4" />
          )}
          {isCreating ? '正在创建项目...' : `创建系列项目（${result.episodes.length} 集）`}
        </button>
        <button
          type="button"
          onClick={onImportToExisting}
          disabled={isCreating}
          className="flex items-center justify-center gap-2 px-4 py-3 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded font-bold text-xs uppercase tracking-widest"
        >
          导入到现有项目
        </button>
      </div>
    </div>
  );
};

export default NovelImportResultPanel;
