/**
 * 剪映草稿导出面板
 *
 * 探测本机剪映草稿目录能力（/api/jianying/capabilities），
 * 将当前时间线组装为草稿载荷提交（/api/jianying/export）。
 */

import React, { useState } from 'react';
import { CheckCircle2, Download, Loader2, XCircle } from 'lucide-react';
import {
  fetchJianyingCapabilities,
  exportJianyingDraft,
} from '../../services/cutos/cutosClient';
import { buildJianyingExportPayload } from '../../services/cutos/jianyingPayload';
import { JianyingCapabilities, TimelineClip, TimelineMedia } from '../../services/cutos/types';

interface Props {
  /** 时间线片段（导出源） */
  clips: TimelineClip[];
  /** 媒体池（导出源） */
  mediaPool: TimelineMedia[];
}

type ExportStage = 'idle' | 'checking' | 'ready' | 'exporting' | 'done' | 'error';

const ExportPanel: React.FC<Props> = ({ clips, mediaPool }) => {
  const [stage, setStage] = useState<ExportStage>('idle');
  const [capabilities, setCapabilities] = useState<JianyingCapabilities | null>(null);
  const [draftName, setDraftName] = useState(`BigBanana-${new Date().toISOString().slice(0, 10)}`);
  const [message, setMessage] = useState('');

  const hasExportableContent = clips.length > 0;

  /** 能力探测 */
  const handleCheck = async (): Promise<void> => {
    setStage('checking');
    setMessage('');
    try {
      const result = await fetchJianyingCapabilities(undefined);
      setCapabilities(result);
      setStage('ready');
    } catch (error) {
      setCapabilities(null);
      setMessage(error instanceof Error ? error.message : String(error));
      setStage('error');
    }
  };

  /** 组装载荷并提交导出 */
  const handleExport = async (): Promise<void> => {
    if (!hasExportableContent) {
      return;
    }
    setStage('exporting');
    setMessage('');
    try {
      const payload = await buildJianyingExportPayload(draftName.trim() || 'BigBanana-Draft', clips, mediaPool);
      const response = await exportJianyingDraft(payload, undefined);
      setMessage(
        `草稿「${response.draftName || draftName}」已写入：${response.draftRoot || capabilities?.draftRoot || '剪映草稿目录'}`
      );
      setStage('done');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStage('error');
    }
  };

  const inputClass =
    'flex-1 px-3 py-2 bg-[var(--bg-sunken)] border border-[var(--border-primary)] rounded text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-border)]';

  return (
    <div className="border border-[var(--border-primary)] rounded-xl bg-[var(--bg-primary)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-sunken)]">
        <Download className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest">
          导出到剪映（推荐剪映 ≤5.9）
        </span>
      </div>

      <div className="p-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider flex-shrink-0">草稿名</span>
          <input type="text" value={draftName} onChange={(event) => setDraftName(event.target.value)} className={inputClass} />
          <button
            type="button"
            onClick={handleCheck}
            disabled={stage === 'checking'}
            className="px-3 py-2 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] rounded text-xs transition-colors flex-shrink-0"
          >
            {stage === 'checking' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '检测目录'}
          </button>
        </div>

        {capabilities != null && stage === 'ready' && (
          <div className="flex items-start gap-2 text-[11px] leading-relaxed">
            {capabilities.available ? (
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[var(--success)] flex-shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 mt-0.5 text-[var(--error)] flex-shrink-0" />
            )}
            <span className="text-[var(--text-secondary)]">
              {capabilities.available
                ? `剪映草稿目录可用：${capabilities.draftRoot || '已探测'}（${capabilities.platform || '本机'}）`
                : `草稿目录不可用：${capabilities.reason || '未检测到剪映安装目录'}`}
            </span>
          </div>
        )}

        {message !== '' && (
          <div
            className={`px-3 py-2 rounded text-[11px] leading-relaxed ${
              stage === 'error'
                ? 'bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/30'
                : 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/30'
            }`}
          >
            {message}
          </div>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={!hasExportableContent || stage === 'exporting'}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors rounded text-xs font-bold uppercase tracking-widest"
        >
          {stage === 'exporting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {stage === 'exporting' ? '正在导出…' : `导出草稿（${clips.length} 个片段）`}
        </button>
        {!hasExportableContent && (
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            时间线为空。先在媒体池添加素材并加入轨道（或让 AI 剪辑助手操作），再导出。
          </p>
        )}
      </div>
    </div>
  );
};

export default ExportPanel;
