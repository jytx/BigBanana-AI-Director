/**
 * 媒体池面板
 *
 * 添加本地视频/音频文件（objectURL + 时长探测），
 * 支持一键加入视频/音频轨道（追加到轨道末尾）与移除。
 */

import React, { useRef } from 'react';
import { Film, Music, Plus, Trash2, Upload } from 'lucide-react';
import { TimelineMedia } from '../../services/cutos/types';

interface Props {
  /** 媒体池 */
  mediaPool: TimelineMedia[];
  /** 时间线上的片段（用于判断素材是否已被引用） */
  clipsUsingMedia: (mediaId: string) => number;
  /** 添加文件（父组件完成时长探测与入库） */
  onAddFiles: (files: FileList) => void;
  /** 加入轨道 */
  onAddToTimeline: (mediaId: string, trackId: 'V1' | 'A1') => void;
  /** 移除素材 */
  onRemoveMedia: (mediaId: string) => void;
}

/** 探测媒体时长（秒）；无法探测时回退 0 并由调用方提示 */
export const probeMediaDuration = (sourceUrl: string, kind: 'video' | 'audio'): Promise<number> =>
  new Promise<number>((resolve) => {
    const element = document.createElement(kind === 'video' ? 'video' : 'audio');
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) ? element.duration : 0;
      resolve(Math.max(0, duration));
    };
    element.onerror = () => resolve(0);
    element.src = sourceUrl;
  });

const MediaPoolPanel: React.FC<Props> = ({ mediaPool, clipsUsingMedia, onAddFiles, onAddToTimeline, onRemoveMedia }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="border border-[var(--border-primary)] rounded-xl bg-[var(--bg-primary)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-sunken)]">
        <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest">媒体池</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-2.5 py-1.5 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] rounded text-xs transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          添加文件
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files != null && event.target.files.length > 0) {
              onAddFiles(event.target.files);
            }
            event.target.value = '';
          }}
        />
      </div>

      {mediaPool.length === 0 ? (
        <div className="p-8 text-center text-xs text-[var(--text-muted)] leading-relaxed">
          暂无素材。添加视频/音频文件后，可通过对话让 AI 剪辑，
          <br />
          或直接点「+V1 / +A1」加入时间线。
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto divide-y divide-[var(--border-primary)]">
          {mediaPool.map((media) => {
            const usageCount = clipsUsingMedia(media.id);
            return (
              <div key={media.id} className="flex items-center gap-2 px-3 py-2.5">
                {media.kind === 'video' ? (
                  <Film className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                ) : (
                  <Music className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-[var(--text-primary)] truncate">{media.name}</div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono">
                    {media.durationSeconds.toFixed(1)}s{usageCount > 0 ? ` · 已用 ${usageCount} 处` : ''}
                  </div>
                </div>
                {media.kind === 'video' ? (
                  <button
                    type="button"
                    onClick={() => onAddToTimeline(media.id, 'V1')}
                    title="加入视频轨道 V1 末尾"
                    className="px-2 py-1 border border-[var(--border-primary)] text-[10px] font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-border)] rounded transition-colors"
                  >
                    <Plus className="w-3 h-3 inline mr-0.5" />V1
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAddToTimeline(media.id, 'A1')}
                    title="加入音频轨道 A1 末尾"
                    className="px-2 py-1 border border-[var(--border-primary)] text-[10px] font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-border)] rounded transition-colors"
                  >
                    <Plus className="w-3 h-3 inline mr-0.5" />A1
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveMedia(media.id)}
                  disabled={usageCount > 0}
                  title={usageCount > 0 ? '时间线仍在引用该素材' : '移除素材'}
                  className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--error)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MediaPoolPanel;
