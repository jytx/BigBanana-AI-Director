/**
 * CutOS 剪辑工作台（页面主组件）
 * 编排媒体池、时间线、AI 剪辑对话、变形转场生成与剪映导出：
 * 对话 → 服务端 Agent 调用剪辑工具 → 返回指令 → 本地应用 → 导出剪映草稿。
 */

import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Scissors, Sparkles } from 'lucide-react';
import {
  buildTimelineSnapshot,
  resolveCutosModelConfig,
  streamCutosAgent,
} from '../../services/cutos/cutosClient';
import { applyTimelineCommand, extractTimelineCommand } from '../../services/cutos/timelineCommands';
import { generateMorphTransition, fetchVideoUrlAsMedia } from '../../services/cutos/morphTransition';
import {
  CutosStreamEvent,
  CutosStreamMessage,
  TimelineClip,
  TimelineMedia,
} from '../../services/cutos/types';
import { useAlert } from '../GlobalAlert';
import AgentChatPanel, { ChatEntry } from './AgentChatPanel';
import ExportPanel from './ExportPanel';
import MediaPoolPanel, { probeMediaDuration } from './MediaPoolPanel';
import TimelineView from './TimelineView';

const CutosWorkbench: React.FC = () => {
  const { showAlert } = useAlert();
  const [mediaPool, setMediaPool] = useState<TimelineMedia[]>([]);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(24);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [liveToolEvents, setLiveToolEvents] = useState<CutosStreamEvent[]>([]);
  const [actionSummaries, setActionSummaries] = useState<string[]>([]);
  const [isGeneratingMorph, setIsGeneratingMorph] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const entryIdRef = useRef(0);

  const mediaDurationsById = useMemo(
    () => new Map(mediaPool.map((media) => [media.id, media.durationSeconds])),
    [mediaPool]
  );
  const pushEntry = (role: ChatEntry['role'], text: string): void => {
    entryIdRef.current += 1;
    setEntries((prev) => [...prev, { id: `entry-${entryIdRef.current}`, role, text }]);
  };

  /** 添加媒体文件：objectURL + 时长探测入库 */
  const handleAddFiles = async (files: FileList): Promise<void> => {
    for (const file of Array.from(files)) {
      const kind: 'video' | 'audio' = file.type.startsWith('audio') ? 'audio' : 'video';
      const sourceUrl = URL.createObjectURL(file);
      const durationSeconds = await probeMediaDuration(sourceUrl, kind);
      setMediaPool((prev) => [
        ...prev,
        {
          id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          durationSeconds,
          kind,
          sourceUrl,
          fileName: file.name,
          file,
        },
      ]);
      if (durationSeconds === 0) {
        showAlert(`素材「${file.name}」时长探测失败（浏览器可能不支持该格式），已按 0 秒入库。`, { type: 'warning' });
      }
    }
  };

  /** 从媒体池加入轨道末尾（与 Agent 的 ADD_MEDIA_TO_TIMELINE 指令同一路径） */
  const handleAddToTimeline = (mediaId: string, trackId: 'V1' | 'A1'): void => {
    const outcome = applyTimelineCommand(clips, mediaDurationsById, 'ADD_MEDIA_TO_TIMELINE', { mediaId, trackId });
    setClips(outcome.clips);
    setActionSummaries((prev) => [...prev, outcome.summary]);
  };

  const handleRemoveMedia = (mediaId: string): void => {
    setMediaPool((prev) => prev.filter((media) => media.id !== mediaId));
  };

  /** 应用一批发自 Agent 的指令（逐条按序应用后统一刷新） */
  const applyCommands = (commands: Array<{ action: string; payload: Record<string, unknown> }>): string[] => {
    let current = clips;
    const summaries: string[] = [];
    for (const command of commands) {
      const outcome = applyTimelineCommand(current, mediaDurationsById, command.action, command.payload);
      current = outcome.clips;
      summaries.push(outcome.summary);
    }
    setClips(current);
    return summaries;
  };

  /** 发送对话：流式渲染 → 结果指令应用 */
  const handleSend = async (input: string): Promise<void> => {
    pushEntry('user', input);
    setIsStreaming(true);
    setStreamingText('');
    setLiveToolEvents([]);
    let modelConfig;
    try {
      modelConfig = resolveCutosModelConfig();
    } catch (error) {
      setIsStreaming(false);
      pushEntry('error', `模型配置不可用：${error instanceof Error ? error.message : '请先在模型管理中配置 chat 模型与 API Key'}`);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const commands: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const handleMessage = (message: CutosStreamMessage): void => {
      if (message.type === 'text-delta') {
        setStreamingText(message.text);
      } else if (message.type === 'event') {
        const event = message.event;
        if (event.type === 'tool:start' || event.type === 'tool:end' || event.type === 'tool:error') {
          setLiveToolEvents((prev) => [...prev, event]);
        }
      } else if (message.type === 'result') {
        for (const toolCall of message.result.toolCalls) {
          const command = extractTimelineCommand(toolCall.result);
          if (command != null) {
            commands.push(command);
          }
        }
      }
    };

    try {
      await streamCutosAgent(
        {
          input,
          modelConfig,
          timelineState: buildTimelineSnapshot(clips, mediaPool, currentTimeSeconds, selectedClipId),
          agentId: 'cutos-default',
        },
        handleMessage,
        controller.signal
      );
      const summaries = applyCommands(commands);
      if (summaries.length > 0) {
        setActionSummaries((prev) => [...prev, ...summaries]);
      }
      pushEntry('assistant', summaries.length > 0 ? summaries.join('\n') : '（无时间线操作）');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const cancelled = messageText.includes('abort') || messageText.includes('cancel');
      pushEntry(cancelled ? 'assistant' : 'error', cancelled ? '已中断本次请求。' : messageText);
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      setStreamingText('');
      setLiveToolEvents([]);
    }
  };

  /** 对选中片段的变形转场标记执行真实生成（结果入媒体池并接续到时间线） */
  const handleGenerateMorph = async (): Promise<void> => {
    const fromClip = clips.find((clip) => clip.id === selectedClipId);
    if (fromClip?.morphTransition == null) {
      showAlert('请先选中一个带「变形转场」标记的片段（可让 AI 执行"为片段创建变形转场"）。', { type: 'info' });
      return;
    }
    const toClip = clips.find((clip) => clip.id === fromClip.morphTransition.toClipId);
    const fromMedia = mediaPool.find((media) => media.id === fromClip.mediaId);
    const toMedia = toClip != null ? mediaPool.find((media) => media.id === toClip.mediaId) : undefined;
    if (toClip == null || fromMedia == null || toMedia == null) {
      showAlert('变形转场的目标片段或其媒体不存在，请重新标记。', { type: 'warning' });
      return;
    }
    setIsGeneratingMorph(true);
    try {
      const videoUrl = await generateMorphTransition({
        fromVideoUrl: fromMedia.sourceUrl,
        fromDurationSeconds: fromClip.durationSeconds,
        toVideoUrl: toMedia.sourceUrl,
        durationSeconds: fromClip.morphTransition.durationSeconds,
      });
      const downloaded = await fetchVideoUrlAsMedia(videoUrl, `morph-${fromClip.id}-to-${toClip.id}.mp4`);
      const morphMedia: TimelineMedia = {
        id: `media-morph-${Date.now()}`,
        name: `变形转场：${fromClip.label} → ${toClip.label}`,
        durationSeconds: downloaded.durationSeconds,
        kind: 'video',
        sourceUrl: downloaded.sourceUrl,
        fileName: downloaded.file.name,
        file: downloaded.file,
      };
      setMediaPool((prev) => [...prev, morphMedia]);
      const outcome = applyTimelineCommand(clips, new Map([[morphMedia.id, morphMedia.durationSeconds]]), 'ADD_MEDIA_TO_TIMELINE', { mediaId: morphMedia.id, trackId: 'V2' });
      setClips(outcome.clips);
      setActionSummaries((prev) => [...prev, '变形转场已生成并加入 V2 轨道']);
      showAlert('变形转场生成完成，已加入媒体池与 V2 轨道。', { type: 'success' });
    } catch (error) {
      showAlert(`变形转场生成失败：${error instanceof Error ? error.message : '未知错误'}`, { type: 'error' });
    } finally {
      setIsGeneratingMorph(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border-primary)] bg-[var(--bg-primary)]">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 flex items-center gap-3">
          <Link
            to="/"
            className="p-2 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] rounded transition-colors"
            title="返回项目列表"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Scissors className="w-5 h-5 text-[var(--accent-text)]" />
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-wide">CutOS 剪辑工作台</h1>
            <p className="text-[11px] text-[var(--text-muted)]">AI 对话式剪辑：分割 / 变速 / 特效 / 绿幕 / 配音 / 人声隔离 / 变形转场，导出剪映草稿</p>
          </div>
          <button
            type="button"
            onClick={handleGenerateMorph}
            disabled={isGeneratingMorph || isStreaming}
            className="flex items-center gap-1.5 px-3 py-2 border border-[var(--accent-border)] text-[var(--accent-text)] hover:bg-[var(--accent-bg)] disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs font-bold transition-colors"
            title="对选中片段的变形转场标记执行 AI 生成"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {isGeneratingMorph ? '生成中…' : '生成变形转场'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-6 py-5 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-5">
            <MediaPoolPanel
              mediaPool={mediaPool}
              clipsUsingMedia={(mediaId) => clips.filter((clip) => clip.mediaId === mediaId).length}
              onAddFiles={handleAddFiles}
              onAddToTimeline={handleAddToTimeline}
              onRemoveMedia={handleRemoveMedia}
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest">时间线</span>
              <div className="flex items-center gap-1.5">
                {[
                  { label: '紧凑', value: 10 },
                  { label: '标准', value: 24 },
                  { label: '展开', value: 48 },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPixelsPerSecond(option.value)}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-colors ${
                      pixelsPerSecond === option.value
                        ? 'border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)]'
                        : 'border-[var(--border-primary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <TimelineView
              clips={clips}
              currentTimeSeconds={currentTimeSeconds}
              selectedClipId={selectedClipId}
              pixelsPerSecond={pixelsPerSecond}
              onSelectClip={(clipId) => setSelectedClipId(clipId === selectedClipId ? null : clipId)}
              onSeek={(timeSeconds) => setCurrentTimeSeconds(timeSeconds)}
            />
            <ExportPanel clips={clips} mediaPool={mediaPool} />
          </div>
          <div className="lg:col-span-1 min-h-[480px]">
            <AgentChatPanel
              entries={entries}
              isStreaming={isStreaming}
              streamingText={streamingText}
              liveToolEvents={liveToolEvents}
              actionSummaries={actionSummaries}
              onSend={handleSend}
              onCancel={() => abortRef.current?.abort()}
            />
          </div>
        </div>
      </main>
    </div>
  );
};

export default CutosWorkbench;
