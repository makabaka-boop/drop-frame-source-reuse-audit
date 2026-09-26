import type { SourceReuseAudit } from '../lib/reuse';
import { formatClipId } from '../lib/analysis';

interface ReuseAuditPanelProps {
  audit: SourceReuseAudit;
  selectedSegmentIndex: number | null;
  onSelectSegment: (index: number | null) => void;
  stale: boolean;
}

export function ReuseAuditPanel({
  audit,
  selectedSegmentIndex,
  onSelectSegment,
  stale
}: ReuseAuditPanelProps) {
  return (
    <section className="panel reuse-panel" aria-label="来源复用审计">
      <div className="panel-heading result-heading">
        <div>
          <h2>来源复用审计（只读）</h2>
          <p>
            各片段 [sourceIn, sourceOut) 投影到同一整数来源帧轴，端点扫描得到被至少两片覆盖的
            最大半开区间；活动片段集合一变即断开，覆盖计数相同也不合并。共{' '}
            <strong>{audit.segmentCount}</strong> 段，复用来源帧{' '}
            <strong>{audit.reusedSourceFrames.toLocaleString('zh-CN')}</strong>，录制落点{' '}
            <strong>{audit.landingCount}</strong> 处。
            {stale && <span className="stale-note">（基于上次合法结果，当前文本非法）</span>}
          </p>
        </div>
      </div>

      {audit.segments.length === 0 ? (
        <div className="contiguous-summary" role="status">
          未发现来源帧复用：每一个来源帧最多只被一个片段引用。
        </div>
      ) : (
        <div className="reuse-segment-list">
          {audit.segments.map((segment) => {
            const selected = segment.index === selectedSegmentIndex;
            return (
              <article
                key={segment.index}
                data-testid={`reuse-card-${segment.index}`}
                className={`reuse-card ${selected ? 'reuse-card-selected' : ''}`}
              >
                <header className="reuse-card-heading">
                  <button
                    type="button"
                    data-testid={`reuse-card-button-${segment.index}`}
                    className="button secondary reuse-card-toggle"
                    aria-pressed={selected}
                    onClick={() => onSelectSegment(selected ? null : segment.index)}
                  >
                    {selected ? '取消高亮' : '在时间线上高亮'}
                  </button>
                  <span>
                    复用段 {segment.index + 1} · {segment.durationFrames} 帧 · {segment.coverageCount} 片覆盖
                  </span>
                </header>

                <dl className="reuse-frames">
                  <div>
                    <dt>来源起点</dt>
                    <dd>
                      {segment.sourceIn.timecode} <em>（帧 {segment.sourceIn.frame}）</em>
                    </dd>
                  </div>
                  <div>
                    <dt>来源止点（排他）</dt>
                    <dd>
                      {segment.sourceOut.timecode} <em>（帧 {segment.sourceOut.frame}）</em>
                    </dd>
                  </div>
                </dl>

                <table className="reuse-landing-table">
                  <thead>
                    <tr>
                      <th>覆盖片段</th>
                      <th>recordIn 落点</th>
                      <th>recordOut 落点（排他）</th>
                      <th>帧数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segment.landings.map((landing) => (
                      <tr key={String(landing.clipId)}>
                        <td className="clip-id">{formatClipId(landing.clipId)}</td>
                        <td>
                          {landing.recordIn.timecode} <em>（帧 {landing.recordIn.frame}）</em>
                        </td>
                        <td>
                          {landing.recordOut.timecode} <em>（帧 {landing.recordOut.frame}）</em>
                        </td>
                        <td className="number">{landing.durationFrames}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
