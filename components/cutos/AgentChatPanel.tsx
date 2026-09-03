/**
 * 剪辑 Agent 对话面板
 *
 * 与 /api/cutos/agent/stream 流式对话：渲染用户消息、助手文本增量、
 * 工具调用事件（start/end/error）；完成后从 result.toolCalls 提取
 * 时间线指令交给父组件应用。
 */

import React, { useEffect, useRef, useState } from 'react';
import { Bot, Send, User, Wrench, X } from 'lucide-react';
import { CutosStreamEvent } from '../../services/cutos/types';

/** 单条对话消息（含流式聚合中的助手消息与工具事件） */
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  toolName?: string;
}

interface Props {
  /** 对话消息列表（父组件持有） */
  entries: ChatEntry[];
  /** 是否正在流式响应 */
  isStreaming: boolean;
  /** 当前流式中的文本（实时渲染） */
  streamingText: string;
  /** 流式过程中到达的工具事件（实时渲染） */
  liveToolEvents: CutosStreamEvent[];
  /** 本轮已应用的动作摘要（时间线变更记录） */
  actionSummaries: string[];
  /** 发送用户输入 */
  onSend: (input: string) => void;
  /** 中断当前流式请求 */
  onCancel: () => void;
}

/** 工具事件的展示行 */
const ToolEventRow: React.FC<{ event: CutosStreamEvent }> = ({ event }) => {
  const isError = event.type === 'tool:error';
  const isEnd = event.type === 'tool:end';
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-mono">
      <Wrench className={`w-3 h-3 flex-shrink-0 ${isError ? 'text-[var(--error)]' : 'text-[var(--accent-text)]'}`} />
      <span className="text-[var(--text-secondary)]">
        {event.toolName || 'tool'}
        {isEnd && event.durationMs != null ? ` · ${event.durationMs}ms` : ''}
        {isError && event.error != null ? ` · ${event.error}` : ''}
      </span>
    </div>
  );
};

const AgentChatPanel: React.FC<Props> = ({
  entries,
  isStreaming,
  streamingText,
  liveToolEvents,
  actionSummaries,
  onSend,
  onCancel,
}) => {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** 新消息/流式更新时自动滚到底部 */
  useEffect(() => {
    const node = scrollRef.current;
    if (node != null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries.length, streamingText, liveToolEvents.length, actionSummaries.length]);

  const handleSubmit = (): void => {
    const trimmed = input.trim();
    if (trimmed === '' || isStreaming) {
      return;
    }
    setInput('');
    onSend(trimmed);
  };

  return (
    <div className="border border-[var(--border-primary)] rounded-xl bg-[var(--bg-primary)] overflow-hidden flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-sunken)]">
        <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest">剪辑助手</span>
        {actionSummaries.length > 0 && (
          <span className="text-[10px] text-[var(--accent-text)] font-mono">
            已执行 {actionSummaries.length} 个操作
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-[280px]">
        {entries.length === 0 && !isStreaming && (
          <div className="text-center text-xs text-[var(--text-muted)] leading-relaxed py-8">
            添加素材后试试：
            <br />
            「把 V1 轨道 5 秒处的片段切开」
            <br />
            「将第一个片段调到 2 倍速并加 noir 特效」
          </div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`flex items-start gap-2 ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {entry.role !== 'user' && (
              <div
                className={`w-6 h-6 rounded flex items-center justify-center flex-shrink-0 ${
                  entry.role === 'error'
                    ? 'bg-[var(--error)]/15 text-[var(--error)]'
                    : 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
                }`}
              >
                {entry.role === 'error' ? <X className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
              </div>
            )}
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed whitespace-pre-wrap break-words ${
                entry.role === 'user'
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)]'
                  : entry.role === 'error'
                    ? 'bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/30'
                    : 'bg-[var(--bg-sunken)] text-[var(--text-primary)]'
              }`}
            >
              {entry.role === 'tool' ? (
                <span className="font-mono text-[10px] text-[var(--text-secondary)]">{entry.text}</span>
              ) : (
                entry.text
              )}
            </div>
            {entry.role === 'user' && (
              <div className="w-6 h-6 rounded bg-[var(--bg-sunken)] text-[var(--text-tertiary)] flex items-center justify-center flex-shrink-0">
                <User className="w-3.5 h-3.5" />
              </div>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-start gap-2">
            <div className="w-6 h-6 rounded bg-[var(--accent-bg)] text-[var(--accent-text)] flex items-center justify-center flex-shrink-0">
              <Bot className="w-3.5 h-3.5 animate-pulse" />
            </div>
            <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--bg-sunken)] text-xs text-[var(--text-primary)] leading-relaxed space-y-1.5">
              {liveToolEvents.map((event) => (
                <ToolEventRow key={event.id} event={event} />
              ))}
              {streamingText !== '' && <div className="whitespace-pre-wrap break-words">{streamingText}</div>}
              {liveToolEvents.length === 0 && streamingText === '' && (
                <span className="text-[var(--text-muted)]">思考中…</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="p-2.5 border-t border-[var(--border-primary)] bg-[var(--bg-sunken)]">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                handleSubmit();
              }
            }}
            placeholder={isStreaming ? 'AI 正在处理…' : '描述你要的剪辑操作…'}
            disabled={isStreaming}
            className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-border)] disabled:opacity-50"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:border-[var(--error)] rounded text-xs transition-colors"
              title="中断"
            >
              <X className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={input.trim() === ''}
              className="px-3 py-2 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-40 rounded transition-colors"
              title="发送"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentChatPanel;
