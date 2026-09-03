/**
 * 时间线视图
 *
 * 按轨道（V2/V1/A1/A2）渲染片段条、播放头与选中态；
 * 点击片段选中，点击空白移动播放头，缩放控制可视时长密度。
 */

import React from 'react';
import { Film, Music } from 'lucide-react';
import { ALL_TRACKS, isVideoTrack, TimelineClip } from '../../services/cutos/types';

interface Props {
  /** 全部片段 */
  clips: TimelineClip[];
  /** 播放头位置（秒） */
  currentTimeSeconds: number;
  /** 选中片段 id */
  selectedClipId: string | null;
  /** 每秒像素密度 */
  pixelsPerSecond: number;
  /** 点击片段 */
  onSelectClip: (clipId: string) => void;
  /** 点击时间轴空白处移动播放头 */
  onSeek: (timeSeconds: number) => void;
}

/** 单轨道渲染 */
const TrackRow: React.FC<{
  trackId: string;
  clips: TimelineClip[];
  selectedClipId: string | null;
  pixelsPerSecond: number;
  onSelectClip: (clipId: string) => void;
}> = ({ trackId, clips, selectedClipId, pixelsPerSecond, onSelectClip }) => {
  const trackClips = clips.filter((clip) => clip.trackId === trackId);
  const video = isVideoTrack(trackId);
  return (
    <div className="flex items-stretch border-b border-[var(--border-primary)]">
      <div className="w-16 flex-shrink-0 flex flex-col items-center justify-center gap-1 border-r border-[var(--border-primary)] bg-[var(--bg-sunken)]">
        {video ? <Film className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <Music className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        <span className="text-[9px] font-bold text-[var(--text-muted)] font-mono">{trackId}</span>
      </div>
      <div className="relative flex-1 h-14 bg-[var(--bg-primary)]">
        {trackClips.map((clip) => {
          const isSelected = clip.id === selectedClipId;
          const badges: string[] = [];
          if (clip.playbackRate != null && Math.abs(clip.playbackRate - 1) > 0.001) badges.push(`${clip.playbackRate}x`);
          if (clip.effects.preset !== 'none') badges.push(clip.effects.preset);
          if (clip.chromakey?.enabled) badges.push('绿幕');
          if (clip.dubLanguage != null) badges.push(`配音:${clip.dubLanguage}`);
          if (clip.voiceIsolated === true) badges.push('人声隔离');
          if (clip.morphTransition != null) badges.push('变形转场');
          return (
            <button
              type="button"
              key={clip.id}
              onClick={() => onSelectClip(clip.id)}
              title={`${clip.label}（${clip.startTimeSeconds.toFixed(1)}s 起，${clip.durationSeconds.toFixed(1)}s）`}
              className={`absolute top-2 bottom-2 rounded border overflow-hidden text-left transition-colors ${
                isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-bg)]'
                  : video
                    ? 'border-[var(--border-secondary)] bg-[var(--bg-elevated)] hover:border-[var(--accent-border)]'
                    : 'border-[var(--border-secondary)] bg-[var(--bg-sunken)] hover:border-[var(--accent-border)]'
              }`}
              style={{
                left: `${clip.startTimeSeconds * pixelsPerSecond}px`,
                width: `${Math.max(8, clip.durationSeconds * pixelsPerSecond - 2)}px`,
              }}
            >
              <div className="px-1.5 py-1">
                <div className="text-[10px] font-bold text-[var(--text-primary)] truncate leading-tight">{clip.label}</div>
                {badges.length > 0 && (
                  <div className="text-[8px] text-[var(--accent-text)] truncate leading-tight mt-0.5">{badges.join(' · ')}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** 时间线主体：刻度行 + 轨道行 + 播放头 */
const TimelineView: React.FC<Props> = ({
  clips,
  currentTimeSeconds,
  selectedClipId,
  pixelsPerSecond,
  onSelectClip,
  onSeek,
}) => {
  const totalSeconds = clips.reduce(
    (maxEnd, clip) => Math.max(maxEnd, clip.startTimeSeconds + clip.durationSeconds),
    30
  );
  const rulerWidth = (totalSeconds + 5) * pixelsPerSecond;
  const ticks: number[] = [];
  const tickStep = pixelsPerSecond >= 40 ? 1 : pixelsPerSecond >= 12 ? 5 : 15;
  for (let t = 0; t <= totalSeconds + 5; t += tickStep) {
    ticks.push(t);
  }

  return (
    <div className="border border-[var(--border-primary)] rounded-xl overflow-hidden bg-[var(--bg-primary)]">
      <div className="flex items-stretch border-b border-[var(--border-primary)]">
        <div className="w-16 flex-shrink-0 flex items-center justify-center border-r border-[var(--border-primary)] bg-[var(--bg-sunken)] text-[9px] font-bold text-[var(--text-muted)] font-mono uppercase tracking-wider">
          刻度
        </div>
        <div
          className="relative flex-1 h-7 bg-[var(--bg-sunken)] cursor-pointer"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, (event.clientX - rect.left) / pixelsPerSecond));
          }}
        >
          {ticks.map((tick) => (
            <div key={tick} className="absolute top-0 bottom-0 flex flex-col items-center" style={{ left: `${tick * pixelsPerSecond}px` }}>
              <div className="w-px h-2 bg-[var(--border-secondary)]" />
              <span className="text-[8px] text-[var(--text-muted)] font-mono mt-0.5 -translate-x-1/2">{tick}s</span>
            </div>
          ))}
        </div>
      </div>

      <div className="relative">
        {ALL_TRACKS.map((trackId) => (
          <TrackRow
            key={trackId}
            trackId={trackId}
            clips={clips}
            selectedClipId={selectedClipId}
            pixelsPerSecond={pixelsPerSecond}
            onSelectClip={onSelectClip}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-[var(--accent)] pointer-events-none z-10"
          style={{ left: `${64 + currentTimeSeconds * pixelsPerSecond}px` }}
        >
          <div className="w-2.5 h-2.5 bg-[var(--accent)] rounded-full -ml-1 -mt-1" />
        </div>
      </div>

      <div className="px-3 py-2 border-t border-[var(--border-primary)] bg-[var(--bg-sunken)] text-[10px] text-[var(--text-muted)] font-mono">
        总时长 {totalSeconds.toFixed(1)}s · 播放头 {currentTimeSeconds.toFixed(1)}s · 每秒 {pixelsPerSecond}px
        <div className="mt-1 w-px" style={{ width: rulerWidth }} />
      </div>
    </div>
  );
};

export default TimelineView;
