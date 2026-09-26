import { useEffect, useMemo, useState } from 'react';
import { Timeline } from './components/Timeline';
import { ResultTable } from './components/ResultTable';
import { SAMPLE_INPUT } from './sample';
import { AnalysisResult, ValidationIssue, analyzeInput, formatClipId } from './lib/analysis';

const ZOOM_LEVELS = [
  { label: '全日览', pixelsPerFrame: 0.0002 },
  { label: '小时', pixelsPerFrame: 0.001 },
  { label: '分钟', pixelsPerFrame: 0.02 },
  { label: '秒', pixelsPerFrame: 0.08 },
  { label: '帧', pixelsPerFrame: 0.7 },
  { label: '放大帧', pixelsPerFrame: 2 }
];

function parseJsonInput(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false as const,
      issues: [
        {
          code: 'JSON_SYNTAX_ERROR',
          message: error instanceof Error ? `JSON 语法错误：${error.message}` : 'JSON 无法解析'
        }
      ]
    };
  }
}

function downloadJson(result: AnalysisResult) {
  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `dropframe-check-${result.rate.replace('/', '_')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [lastResult, setLastResult] = useState<AnalysisResult | null>(null);
  const [zoomIndex, setZoomIndex] = useState(1);

  const response = useMemo(() => {
    const parsed = parseJsonInput(inputText);
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'ok' in parsed
      && (parsed as { ok?: boolean }).ok === false
    ) {
      return parsed as { ok: false; issues: ValidationIssue[] };
    }
    return analyzeInput(parsed);
  }, [inputText]);

  useEffect(() => {
    if (response.ok) {
      setLastResult(response.result);
    }
  }, [response]);

  const activeResult = response.ok ? response.result : null;
  const shownResult = activeResult ?? lastResult;
  const stale = !response.ok;
  const issues = response.ok ? [] : response.issues;

  async function importFile(file: File | undefined) {
    if (!file) return;
    setInputText(await file.text());
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">SMPTE 30000/1001 · 60000/1001</p>
          <h1>丢帧时码合版核对台</h1>
          <p className="subtitle">
            时码先转换为整数帧，再计算 recordOut、空隙与重叠；标尺和表格引用同一份不可变结果。
          </p>
        </div>
        <div className={`status-card ${stale ? 'status-stale' : 'status-valid'}`}>
          <span className="status-dot" />
          <strong>{stale ? '当前结论已撤销' : '当前输入有效'}</strong>
          <small>非法编辑不会替换上次合法结果</small>
        </div>
      </header>

      <section className="workspace-grid">
        <div className="panel input-panel">
          <div className="panel-heading">
            <div>
              <h2>输入 JSON</h2>
              <p>固定 HH:MM:SS;FF，sourceOut 为排他端，数量 1–200。</p>
            </div>
            <div className="button-row">
              <label className="button secondary">
                导入文件
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    void importFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="button secondary" onClick={() => setInputText(SAMPLE_INPUT)}>
                示例
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!activeResult}
                onClick={() => activeResult && downloadJson(activeResult)}
              >
                导出核对 JSON
              </button>
            </div>
          </div>
          <textarea
            spellCheck={false}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            aria-label="片段 JSON 输入"
          />
          {stale && (
            <div className="issue-list" role="alert">
              <h3>整份输入已拒绝</h3>
              <ul>
                {issues.map((item, index) => (
                  <li key={`${item.code}-${index}`}>
                    {item.path && <code>{item.path}</code>}
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="panel rules-panel">
          <h2>丢帧规则</h2>
          <ul>
            <li>29.97：每个非整十分钟跳过 <code>;00</code>、<code>;01</code>。</li>
            <li>59.94：每个非整十分钟跳过 <code>;00</code> 至 <code>;03</code>。</li>
            <li>整十分钟和小时边界不跳帧，不能按普通时分秒乘 30/60。</li>
            <li>recordOut = recordIn + (sourceOut − sourceIn)，触碰 24 小时即拒绝。</li>
          </ul>
        </div>
      </section>

      {shownResult && (
        <section className="panel result-panel">
          <div className="panel-heading result-heading">
            <div>
              <h2>核对结果</h2>
              <p>
                全局 rate <code>{shownResult.rate}</code> · 日帧长{' '}
                <strong>{shownResult.dayFrames.toLocaleString('zh-CN')}</strong> ·{' '}
                {shownResult.clips.length} 个片段 · {shownResult.breaks.length} 处断点
                {stale && <span className="stale-note">（以下为上次合法结果，不对应当前文本）</span>}
              </p>
            </div>
            <div className="zoom-controls" aria-label="缩放标尺">
              <button
                type="button"
                className="button icon"
                disabled={zoomIndex === 0}
                onClick={() => setZoomIndex((value) => Math.max(0, value - 1))}
              >
                −
              </button>
              <span>{ZOOM_LEVELS[zoomIndex].label}</span>
              <button
                type="button"
                className="button icon"
                disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                onClick={() => setZoomIndex((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}
              >
                +
              </button>
            </div>
          </div>

          {shownResult.firstBreak ? (
            <div className="first-break-summary" role="status">
              <strong>第一处真实拼接断点</strong>
              <span>
                {shownResult.firstBreak.kind === 'gap' ? '空隙' : '重叠'}：片段{' '}
                <code>{formatClipId(shownResult.firstBreak.afterClipId)}</code> 与{' '}
                <code>{formatClipId(shownResult.firstBreak.beforeClipId)}</code> 之间，
                {shownResult.firstBreak.start.timecode} → {shownResult.firstBreak.end.timecode}，共{' '}
                {shownResult.firstBreak.durationFrames} 帧。
              </span>
            </div>
          ) : (
            <div className="contiguous-summary" role="status">
              所有片段按录制位置首尾相接，未发现空隙或重叠。
            </div>
          )}

          <Timeline
            result={shownResult}
            pixelsPerFrame={ZOOM_LEVELS[zoomIndex].pixelsPerFrame}
            active={!stale}
          />
          <ResultTable clips={shownResult.clips} />
        </section>
      )}

      {!shownResult && (
        <section className="panel empty-state">
          <h2>尚无合法结果</h2>
          <p>修正输入后才会生成整数帧、recordOut 与拼接断点。</p>
        </section>
      )}
    </main>
  );
}
