import { useEffect, useMemo, useRef, useState } from 'react';
import { AnalysisResult, formatClipId } from '../lib/analysis';
import { formatFrame } from '../lib/timecode';
import { computeTimelineTicks } from '../lib/timeline';
import type { SourceReuseAudit } from '../lib/reuse';

interface TimelineProps {
  result: AnalysisResult;
  reuseAudit: SourceReuseAudit | null;
  selectedSegmentIndex: number | null;
  onSelectSegment: (index: number | null) => void;
  pixelsPerFrame: number;
  active: boolean;
}

const SVG_HEIGHT = 176;

export function Timeline({
  result,
  reuseAudit,
  selectedSegmentIndex,
  onSelectSegment,
  pixelsPerFrame,
  active
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1200 });
  const width = Math.max(1, result.dayFrames * pixelsPerFrame);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const update = () => {
      setViewport({ scrollLeft: element.scrollLeft, width: element.clientWidth });
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    if (!active || !result.firstBreak) return;
    document.getElementById('timeline-first-break')?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    });
  }, [active, result.firstBreak]);

  useEffect(() => {
    if (selectedSegmentIndex === null) return;
    document.getElementById(`timeline-reuse-segment-${selectedSegmentIndex}`)?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    });
  }, [selectedSegmentIndex]);

  const ticks = useMemo(
    () => computeTimelineTicks(pixelsPerFrame, viewport, result.dayFrames),
    [pixelsPerFrame, viewport, result.dayFrames]
  );

  const selectedSegment =
    selectedSegmentIndex !== null && reuseAudit
      ? reuseAudit.segments.find((segment) => segment.index === selectedSegmentIndex) ?? null
      : null;

  const x = (frame: number) => frame * pixelsPerFrame;
  const toggleSegment = (index: number) => {
    onSelectSegment(index === selectedSegmentIndex ? null : index);
  };

  return (
    <div
      ref={scrollRef}
      className={`timeline-scroll ${active ? '' : 'timeline-stale'}`}
      aria-label="按录制帧位置绘制的可缩放时间线"
    >
      <svg className="timeline-svg" width={width} height={SVG_HEIGHT} role="img">
        <rect x="0" y="0" width={width} height={SVG_HEIGHT} className="timeline-background" />
        <line x1="0" y1="38" x2={width} y2="38" className="ruler-line" />

        {ticks.values.map((frame) => (
          <g key={frame}>
            <line x1={x(frame)} y1="30" x2={x(frame)} y2="38" className="ruler-tick" />
            {ticks.step * pixelsPerFrame >= 72 && (
              <text x={x(frame) + 3} y="22" className="ruler-label">
                {formatFrame(frame, result.rate)}
              </text>
            )}
          </g>
        ))}

        {result.breaks.map((breakItem, index) => {
          const left = x(breakItem.start.frame);
          const intervalWidth = Math.max(2, breakItem.durationFrames * pixelsPerFrame);
          return (
            <g key={`${breakItem.kind}-${index}`}>
              <rect
                x={left}
                y={80}
                width={intervalWidth}
                height={16}
                className={breakItem.kind === 'gap' ? 'gap-band' : 'overlap-band'}
              >
                <title>
                  {`${breakItem.kind === 'gap' ? '空隙' : '重叠'} ${breakItem.durationFrames} 帧：${breakItem.start.timecode} → ${breakItem.end.timecode}`}
                </title>
              </rect>
            </g>
          );
        })}

        {result.clips.map((clip, index) => {
          const left = x(clip.recordIn.frame);
          const clipWidth = Math.max(2, clip.durationFrames * pixelsPerFrame);
          return (
            <g key={`${String(clip.id)}-${index}`}>
              <rect
                x={left}
                y={48}
                width={clipWidth}
                height={28}
                className={`clip-rect clip-${clip.relation} ${clip.firstBreak ? 'clip-first-break' : ''}`}
              >
                <title>
                  {`片段 ${formatClipId(clip.id)}\nrecordIn ${clip.recordIn.timecode}\nrecordOut ${clip.recordOut.timecode}\n时长 ${clip.durationFrames} 帧`}
                </title>
              </rect>
              {clipWidth >= 34 && (
                <text x={left + 6} y="67" className="clip-label">
                  {formatClipId(clip.id)}
                </text>
              )}
            </g>
          );
        })}

        {/* 选中来源复用段后，录制时间线上的全部落点同时高亮。 */}
        {selectedSegment?.landings.map((landing, landingIndex) => {
          const left = x(landing.recordIn.frame);
          const landingWidth = Math.max(2, landing.durationFrames * pixelsPerFrame);
          return (
            <rect
              key={`landing-${selectedSegment.index}-${landingIndex}`}
              data-testid={`reuse-landing-${selectedSegment.index}-${landingIndex}`}
              data-segment-index={selectedSegment.index}
              x={left}
              y={44}
              width={landingWidth}
              height={36}
              rx={6}
              className="reuse-landing-highlight"
              role="button"
              aria-label={`来源复用段 ${selectedSegment.index + 1} 在片段 ${formatClipId(landing.clipId)} 录制时间线上的落点`}
              onClick={() => toggleSegment(selectedSegment.index)}
            >
              <title>
                {`复用落点：片段 ${formatClipId(landing.clipId)}\nrecordIn ${landing.recordIn.timecode}（${landing.recordIn.frame} 帧）\nrecordOut ${landing.recordOut.timecode}（${landing.recordOut.frame} 帧）`}
              </title>
            </rect>
          );
        })}

        {result.firstBreak && (
          <g id="timeline-first-break">
            <line
              x1={x(result.firstBreak.start.frame)}
              y1="4"
              x2={x(result.firstBreak.start.frame)}
              y2={SVG_HEIGHT - 8}
              className="first-break-line"
            />
            <text x={x(result.firstBreak.start.frame) + 6} y="126" className="first-break-label">
              第一断点
            </text>
          </g>
        )}

        {/* 来源轴：与录制轴共用同一整数帧像素尺度，但投影的是 sourceIn/sourceOut。 */}
        <line x1="0" y1="104" x2={width} y2="104" className="ruler-line" />
        <text x="6" y="118" className="lane-label">
          来源轴
        </text>

        {result.clips.map((clip, index) => {
          const left = x(clip.sourceIn.frame);
          const clipWidth = Math.max(2, clip.durationFrames * pixelsPerFrame);
          return (
            <rect
              key={`source-${String(clip.id)}-${index}`}
              x={left}
              y="124"
              width={clipWidth}
              height={26}
              className="source-clip-rect"
            >
              <title>
                {`片段 ${formatClipId(clip.id)} 来源\n${clip.sourceIn.timecode} → ${clip.sourceOut.timecode}（${clip.durationFrames} 帧）`}
              </title>
            </rect>
          );
        })}

        {reuseAudit?.segments.map((segment) => {
          const left = x(segment.sourceIn.frame);
          const segmentWidth = Math.max(2, segment.durationFrames * pixelsPerFrame);
          const isSelected = segment.index === selectedSegmentIndex;
          return (
            <rect
              key={`reuse-${segment.index}`}
              id={`timeline-reuse-segment-${segment.index}`}
              data-testid={`reuse-source-segment-${segment.index}`}
              data-segment-index={segment.index}
              x={left}
              y="120"
              width={segmentWidth}
              height={34}
              rx={6}
              className={`reuse-source-segment ${isSelected ? 'reuse-source-segment-selected' : ''}`}
              role="button"
              aria-pressed={isSelected}
              aria-label={`来源复用段 ${segment.index + 1}：${segment.sourceIn.timecode} 至 ${segment.sourceOut.timecode}`}
              onClick={() => toggleSegment(segment.index)}
            >
              <title>
                {`来源复用段 ${segment.index + 1}\n${segment.sourceIn.timecode}（${segment.sourceIn.frame} 帧）→ ${segment.sourceOut.timecode}（${segment.sourceOut.frame} 帧）\n${segment.durationFrames} 帧被 ${segment.coverageCount} 片覆盖：${segment.coverageClipIds.map(formatClipId).join('、')}`}
              </title>
            </rect>
          );
        })}

        <text x="6" y="60" className="lane-label">
          录制轴
        </text>
      </svg>
    </div>
  );
}
