/**
 * 小说导入目标项目选择器
 *
 * 「导入到现有项目」落地路径：选择一个既有系列项目，
 * 展示其现有集与导入草稿的对照，经高风险确认后由父组件执行逐集覆盖。
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, Folder } from 'lucide-react';
import { SeriesProject } from '../../types';
import { getAllSeriesProjects, getEpisodesByProject } from '../../services/storageService';
import { useAlert } from '../GlobalAlert';
import { NovelImportResult } from '../../services/novelImport/types';

interface Props {
  /** 导入结果（用于集数对照与后续覆盖） */
  result: NovelImportResult;
  /** 是否正在执行导入 */
  isImporting: boolean;
  /** 确认后回调目标项目 id，由父组件执行覆盖落地 */
  onImport: (projectId: string) => void;
  /** 返回结果预览 */
  onCancel: () => void;
}

const NovelImportTargetPicker: React.FC<Props> = ({ result, isImporting, onImport, onCancel }) => {
  const { showAlert } = useAlert();
  const [projects, setProjects] = useState<SeriesProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [existingCount, setExistingCount] = useState<number | null>(null);

  /** 加载全部系列项目供选择 */
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await getAllSeriesProjects();
        if (!cancelled) {
          setProjects(list);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 选中项目后加载其现有集数（用于覆盖范围对照） */
  const handleSelect = async (projectId: string): Promise<void> => {
    setSelectedId(projectId);
    setExistingCount(null);
    if (projectId === '') {
      return;
    }
    const episodes = await getEpisodesByProject(projectId);
    setExistingCount(episodes.length);
  };

  /** 高风险确认（覆盖现有集内容）后回调父组件执行 */
  const handleConfirm = (): void => {
    if (selectedId === '') {
      return;
    }
    showAlert('该操作会覆盖当前集数中的内容（按集号对应，超出部分新建）。是否继续？', {
      type: 'warning',
      showCancel: true,
      onConfirm: () => onImport(selectedId),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回结果预览
        </button>
        <span className="text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-widest">
          待导入 {result.episodes.length} 集
        </span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-5 h-5 text-[var(--text-muted)] animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className="border border-dashed border-[var(--border-primary)] rounded-xl p-8 text-center text-sm text-[var(--text-muted)]">
          暂无现有项目，请使用「创建系列项目」。
        </div>
      ) : (
        <>
          <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
            {projects.map((project) => {
              const isSelected = project.id === selectedId;
              return (
                <button
                  type="button"
                  key={project.id}
                  onClick={() => handleSelect(project.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 border rounded-lg text-left transition-colors ${
                    isSelected
                      ? 'border-[var(--accent-border)] bg-[var(--accent-bg)]'
                      : 'border-[var(--border-primary)] hover:border-[var(--border-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Folder className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-[var(--text-primary)] truncate">{project.title}</div>
                    <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">
                      {project.description || '暂无描述'}
                    </div>
                  </div>
                  {isSelected && existingCount != null && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">
                      现有 {existingCount} 集
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedId !== '' && (
            <div className="flex items-start gap-2 px-3 py-2 border border-[var(--warning)]/40 bg-[var(--warning)]/10 rounded text-[11px] text-[var(--text-primary)] leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-[var(--warning)] flex-shrink-0" />
              <span>
                将向该项目导入 {result.episodes.length} 集草稿
                {existingCount != null ? `（现有 ${existingCount} 集，同集号内容将被覆盖` : ''}
                {existingCount != null && result.episodes.length > (existingCount ?? 0)
                  ? '，超出部分新建'
                  : ''}
                {existingCount != null ? '）' : ''}。
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={handleConfirm}
            disabled={selectedId === '' || isImporting}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded font-bold text-xs uppercase tracking-widest"
          >
            {isImporting && <Loader2 className="w-4 h-4 animate-spin" />}
            {isImporting ? '正在导入...' : '继续导入'}
          </button>
        </>
      )}
    </div>
  );
};

export default NovelImportTargetPicker;
