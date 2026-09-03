/**
 * 小说导入表单
 *
 * 承载全部表单字段（正文/时长/集数/剧集名/语言）与前置校验
 * （校验文案对齐官方 studio 版），校验通过后以归一化参数回调父组件。
 */

import React, { useState } from 'react';
import { Upload } from 'lucide-react';
import { parseDurationToSeconds } from '../../services/durationParser';
import { MAX_NOVEL_LENGTH } from '../../services/novelImport/sectioning';
import { buildOverlongMessage } from '../../services/novelImport/novelImportService';

/** 表单校验通过后提交给父组件的归一化参数 */
export interface NovelImportSubmitParams {
  rawNovel: string;
  targetDuration: string;
  desiredEpisodeCount: number | undefined;
  seriesTitle: string | undefined;
  language: string;
}

interface Props {
  /** 父组件传入的运行期错误信息（与本地校验错误合并展示，优先级更高） */
  externalError: string;
  onSubmit: (params: NovelImportSubmitParams) => void;
}

/** 预设时长选项（与官方下拉一致），custom 为自定义输入 */
const DURATION_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '30 秒', value: '30s' },
  { label: '60 秒', value: '60s' },
  { label: '2 分钟', value: '120s' },
  { label: '5 分钟', value: '300s' },
  { label: '自定义…', value: 'custom' },
];

/** 校验时长选择：返回错误文案，或 null 表示通过（通过时经第二个出参返回时长值） */
const validateDuration = (choice: string, custom: string): { error: string } | { duration: string } => {
  if (choice !== 'custom') {
    return { duration: choice };
  }
  const trimmed = custom.trim();
  if (trimmed === '') {
    return { error: '请先填写单集目标时长。' };
  }
  if (parseDurationToSeconds(trimmed) === null) {
    return { error: '单集目标时长格式无效，请使用如 90s、3m、2m30s 或 2:30。' };
  }
  return { duration: trimmed };
};

const NovelImportForm: React.FC<Props> = ({ externalError, onSubmit }) => {
  const [rawNovel, setRawNovel] = useState('');
  const [fileName, setFileName] = useState('');
  const [durationChoice, setDurationChoice] = useState('60s');
  const [customDuration, setCustomDuration] = useState('');
  const [episodeCountInput, setEpisodeCountInput] = useState('');
  const [seriesTitle, setSeriesTitle] = useState('');
  const [language, setLanguage] = useState('中文');
  const [localError, setLocalError] = useState('');

  /** 读取 .txt/.md 文件内容到正文输入 */
  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file == null) {
      return;
    }
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.txt') && !lowerName.endsWith('.md')) {
      setLocalError('仅支持上传 .txt 或 .md 格式的小说文件。');
      return;
    }
    const text = await file.text();
    setRawNovel(text);
    setFileName(file.name);
    setLocalError('');
  };

  /** 提交：前置校验（对齐官方错误文案），全部通过后回调归一化参数 */
  const handleSubmit = (): void => {
    if (rawNovel.trim() === '') {
      setLocalError('请先粘贴小说正文，或上传一个 `.txt/.md` 小说文件。');
      return;
    }
    const charCount = rawNovel.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim().length;
    if (charCount > MAX_NOVEL_LENGTH) {
      setLocalError(buildOverlongMessage(charCount));
      return;
    }
    const durationResult = validateDuration(durationChoice, customDuration);
    if ('error' in durationResult) {
      setLocalError(durationResult.error);
      return;
    }
    const countText = episodeCountInput.trim();
    if (countText !== '' && (!/^\d+$/.test(countText) || Number(countText) < 1 || Number(countText) > 24)) {
      setLocalError('目标集数请填写 1 到 24 之间的整数，或留空让系统自动拆分。');
      return;
    }
    setLocalError('');
    onSubmit({
      rawNovel,
      targetDuration: durationResult.duration,
      desiredEpisodeCount: countText === '' ? undefined : Number(countText),
      seriesTitle: seriesTitle.trim() === '' ? undefined : seriesTitle.trim(),
      language,
    });
  };

  const inputClass =
    'w-full px-3 py-2 bg-[var(--bg-sunken)] border border-[var(--border-primary)] rounded text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-border)]';
  const labelClass = 'block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1.5';
  const shownError = externalError !== '' ? externalError : localError;

  return (
    <div className="space-y-4">
      {shownError !== '' && (
        <div className="px-3 py-2 border border-[var(--error)]/40 bg-[var(--error)]/10 rounded text-xs text-[var(--error)] leading-relaxed">
          {shownError}
        </div>
      )}

      <div>
        <label className={labelClass}>小说正文（限 5 万字）</label>
        <textarea
          value={rawNovel}
          onChange={(e) => setRawNovel(e.target.value)}
          placeholder="粘贴小说正文，或通过下方按钮上传 .txt / .md 文件…"
          rows={8}
          className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
        />
        <div className="flex items-center justify-between mt-2">
          <button
            type="button"
            onClick={() => document.getElementById('novel-import-file-input')?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)] rounded text-xs transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            上传文件
          </button>
          <span className="text-[10px] text-[var(--text-muted)] font-mono">
            {fileName !== '' ? `${fileName} · ` : ''}
            {rawNovel.length.toLocaleString('zh-CN')} 字
          </span>
        </div>
        <input
          id="novel-import-file-input"
          type="file"
          accept=".txt,.md"
          className="hidden"
          onChange={handleFileSelected}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>单集目标时长 *</label>
          <select value={durationChoice} onChange={(e) => setDurationChoice(e.target.value)} className={inputClass}>
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {durationChoice === 'custom' && (
            <input
              type="text"
              value={customDuration}
              onChange={(e) => setCustomDuration(e.target.value)}
              placeholder="如 90s、3m、2m30s、2:30"
              className={`${inputClass} mt-2`}
            />
          )}
        </div>
        <div>
          <label className={labelClass}>目标集数（留空自动拆分）</label>
          <input
            type="text"
            value={episodeCountInput}
            onChange={(e) => setEpisodeCountInput(e.target.value)}
            placeholder="1 - 24 的整数"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>剧集名（可选）</label>
          <input
            type="text"
            value={seriesTitle}
            onChange={(e) => setSeriesTitle(e.target.value)}
            placeholder="留空由 AI 拟定"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>输出语言</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
            <option value="中文">中文</option>
            <option value="English">English</option>
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        className="w-full px-4 py-3 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] transition-colors rounded font-bold text-xs uppercase tracking-widest"
      >
        开始分析小说并规划分集
      </button>
    </div>
  );
};

export default NovelImportForm;
