/**
 * 小说导入对话框（状态机）
 *
 * 表单（NovelImportForm）→ 运行中（实时进度、可取消）
 * → 结果预览（NovelImportResultPanel）→ 落地为系列项目（同一系列创建全部集）。
 */

import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Loader2, X } from 'lucide-react';
import { generateNovelImportResult } from '../../services/novelImport/novelImportService';
import { NovelImportResult } from '../../services/novelImport/types';
import {
  createNewEpisode,
  createNewSeries,
  createNewSeriesProject,
  saveEpisode,
  saveSeries,
  saveSeriesProject,
} from '../../services/storageService';
import { useAlert } from '../GlobalAlert';
import NovelImportForm, { NovelImportSubmitParams } from './NovelImportForm';
import NovelImportResultPanel from './NovelImportResultPanel';
import NovelImportTargetPicker from './NovelImportTargetPicker';
import { getEpisodesByProject } from '../../services/storageService';

interface Props {
  onClose: () => void;
}

/** 对话框阶段：表单 / 运行中 / 结果预览 / 选择目标项目 */
type DialogStage = 'form' | 'running' | 'result' | 'target';

const NovelImportDialog: React.FC<Props> = ({ onClose }) => {
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [stage, setStage] = useState<DialogStage>('form');
  const [runError, setRunError] = useState('');
  const [progressMsg, setProgressMsg] = useState('');
  const [result, setResult] = useState<NovelImportResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** 启动导入流水线：进度实时上报，取消/失败均回到表单并展示原因 */
  const handleStart = async (params: NovelImportSubmitParams): Promise<void> => {
    setRunError('');
    setProgressMsg('正在分析小说并规划分集...');
    setStage('running');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const importResult = await generateNovelImportResult({
        ...params,
        abortSignal: controller.signal,
        onProgress: setProgressMsg,
      });
      if (importResult.episodes.length === 0) {
        setRunError('拆分结果为空，未生成任何分集草稿。');
        setStage('form');
        return;
      }
      setResult(importResult);
      setStage('result');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message.includes('Request cancelled') ? '已取消导入。' : message);
      setStage('form');
    } finally {
      abortRef.current = null;
    }
  };

  /** 落地（新建路径）：按导入结果创建系列项目与全部集，随后跳转项目页 */
  const handleCreateProject = async (): Promise<void> => {
    if (result == null) {
      return;
    }
    setIsCreating(true);
    try {
      const seriesProject = createNewSeriesProject(result.projectTitle);
      seriesProject.description = result.projectDescription;
      seriesProject.language = result.language;
      await saveSeriesProject(seriesProject);
      const series = createNewSeries(seriesProject.id, result.seriesTitle, 0);
      await saveSeries(series);
      for (const draft of result.episodes) {
        const episode = createNewEpisode(seriesProject.id, series.id, draft.episodeNumber, draft.title);
        episode.rawScript = draft.rawScript;
        episode.targetDuration = result.targetDuration;
        episode.language = result.language;
        await saveEpisode(episode);
      }
      navigate(`/project/${seriesProject.id}`);
    } catch (error) {
      showAlert(`创建项目失败: ${error instanceof Error ? error.message : '未知错误'}`, { type: 'error' });
      setIsCreating(false);
    }
  };

  /** 落地（覆盖路径）：按集号匹配现有集覆盖，超出部分新建，完成后跳转项目页 */
  const handleImportToExisting = async (projectId: string): Promise<void> => {
    if (result == null) {
      return;
    }
    setIsCreating(true);
    try {
      const existingEpisodes = await getEpisodesByProject(projectId);
      const episodeByNumber = new Map(existingEpisodes.map((episode) => [episode.episodeNumber, episode]));
      const firstExisting = existingEpisodes[0];
      for (const draft of result.episodes) {
        const matched = episodeByNumber.get(draft.episodeNumber);
        if (matched != null) {
          matched.title = draft.title;
          matched.rawScript = draft.rawScript;
          matched.targetDuration = result.targetDuration;
          matched.language = result.language;
          matched.lastModified = Date.now();
          await saveEpisode(matched);
        } else {
          const episode = createNewEpisode(
            projectId,
            firstExisting?.seriesId || '',
            draft.episodeNumber,
            draft.title
          );
          episode.rawScript = draft.rawScript;
          episode.targetDuration = result.targetDuration;
          episode.language = result.language;
          await saveEpisode(episode);
        }
      }
      navigate(`/project/${projectId}`);
    } catch (error) {
      showAlert(`导入项目失败: ${error instanceof Error ? error.message : '未知错误'}`, { type: 'error' });
      setIsCreating(false);
    }
  };

  /** 关闭对话框时同步中断仍在进行的导入 */
  const handleClose = (): void => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/70 p-4 md:p-6"
      onClick={handleClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--bg-primary)] border border-[var(--border-primary)] p-5 md:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-4 top-4 p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 mb-5 pr-10">
          <BookOpen className="w-5 h-5 text-[var(--accent-text)]" />
          <h2 className="text-base font-bold text-[var(--text-primary)] tracking-wide">小说导入</h2>
        </div>

        {stage === 'form' && <NovelImportForm externalError={runError} onSubmit={handleStart} />}

        {stage === 'running' && (
          <div className="py-12 flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 text-[var(--accent-text)] animate-spin" />
            <p className="text-sm text-[var(--text-primary)]">{progressMsg}</p>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed text-center max-w-md">
              长篇小说需要多轮 AI 处理（片段提炼 → 分集规划 → 逐集草稿），可能耗时数分钟，请耐心等待。
            </p>
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="mt-2 px-4 py-2 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] rounded text-xs transition-colors"
            >
              取消导入
            </button>
          </div>
        )}

        {stage === 'result' && result != null && (
          <NovelImportResultPanel
            result={result}
            isCreating={isCreating}
            onCreateProject={handleCreateProject}
            onImportToExisting={() => setStage('target')}
          />
        )}

        {stage === 'target' && result != null && (
          <NovelImportTargetPicker
            result={result}
            isImporting={isCreating}
            onImport={handleImportToExisting}
            onCancel={() => setStage('result')}
          />
        )}
      </div>
    </div>
  );
};

export default NovelImportDialog;
