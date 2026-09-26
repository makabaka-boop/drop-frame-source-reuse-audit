import type { AnalysisResult, AnalyzedClip, ClipId, FrameTimecode } from './analysis';
import { toFrameTimecode } from './timecode';
import type { DropFrameRate } from './timecode';

/**
 * 来源复用审计（只读派生视图）。
 *
 * 合版后录制时间线可能首尾相接，但同一段来源素材会被多个片段重复引用。
 * 本模块把每片 [sourceIn, sourceOut) 投到同一条整数来源帧轴上，用端点扫描
 * （sweep line）找出被至少两个片段同时覆盖的最大半开区间。
 *
 * 裁决全部使用整数帧：半开区间 [a, b) 恰覆盖 b-a 个帧，端点相接（一片排他端
 * 正好等于另一片起点）不产生复用。时码仅用于展示，不参与比较。
 */

export interface SourceReuseLanding {
  /** 落点所属片段 id；数值 id 与同字面字符串 id 是不同身份。 */
  clipId: ClipId;
  /** 复用段在该片段录制时间线上对应的起点（含）。 */
  recordIn: FrameTimecode;
  /** 复用段在该片段录制时间线上对应的终点（排他）。 */
  recordOut: FrameTimecode;
  /** 落点帧数，恒等于来源复用段长度。 */
  durationFrames: number;
}

export interface SourceReuseSegment {
  /** 按来源起点排序后的序号，从 0 开始。 */
  index: number;
  sourceIn: FrameTimecode;
  sourceOut: FrameTimecode;
  durationFrames: number;
  /** 覆盖该段的片段数，恒大于等于 2。 */
  coverageCount: number;
  /** 覆盖片段 id，按录制位置（AnalyzedClip 顺序）排列。 */
  coverageClipIds: ClipId[];
  /** 每个覆盖片段各自在录制时间线上的落点。 */
  landings: SourceReuseLanding[];
}

export interface SourceReuseAudit {
  schemaVersion: 1;
  rate: DropFrameRate;
  dayFrames: number;
  segmentCount: number;
  /** 来源轴上处于复用状态的帧总数；各最大段互不相交，可直接相加。 */
  reusedSourceFrames: number;
  /** 全部复用段的落点总数（各段覆盖片段数之和）。 */
  landingCount: number;
  segments: SourceReuseSegment[];
}

export interface SourceReuseReport extends SourceReuseAudit {
  reportType: 'source-reuse-audit';
}

interface SweepEvent {
  frame: number;
  /** +1 进入，-1 离开；同一帧上离开先于进入，保证端点相接不被算作覆盖。 */
  delta: -1 | 1;
  clip: AnalyzedClip;
}

function sameIds(a: ClipId[], b: ClipId[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/**
 * 端点扫描。扫描线上相邻事件之间活动集合恒定；只要活动片段 id 集合发生变化
 * （即使覆盖计数不变）就必须断开为新段，绝不合并。
 */
export function computeSourceReuseAudit(result: AnalysisResult): SourceReuseAudit {
  const { rate, dayFrames, clips } = result;

  const events: SweepEvent[] = [];
  for (const clip of clips) {
    events.push({ frame: clip.sourceIn.frame, delta: 1, clip });
    events.push({ frame: clip.sourceOut.frame, delta: -1, clip });
  }
  // 同帧先收尾后开场：半开区间在共享端点处互不覆盖。
  events.sort((a, b) => a.frame - b.frame || a.delta - b.delta);

  const clipById = new Map<ClipId, AnalyzedClip>();
  for (const clip of clips) {
    clipById.set(clip.id, clip);
  }

  const active = new Set<ClipId>();
  const pieces: { start: number; end: number; ids: ClipId[] }[] = [];
  let open: { start: number; end: number; ids: ClipId[] } | null = null;

  const flush = (start: number, end: number) => {
    if (end <= start) {
      // 零长度基本区间：活动状态不变，无需处理。
      return;
    }
    if (active.size < 2) {
      // 不足两片覆盖：此前打开的复用段在此结束，必须先落盘。
      if (open) {
        pieces.push(open);
        open = null;
      }
      return;
    }
    // clips 已按录制位置排序且 id 唯一，过滤即得到确定性的活动 id 序列。
    const ids = clips.filter((clip) => active.has(clip.id)).map((clip) => clip.id);
    if (open && sameIds(open.ids, ids)) {
      // 理论上事件边界两侧集合必变；保留显式判等，集合不变才延伸。
      open.end = end;
    } else {
      if (open) pieces.push(open);
      open = { start, end, ids };
    }
  };

  let cursor = events.length > 0 ? events[0].frame : 0;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    const frame = events[eventIndex].frame;

    // [cursor, frame) 内活动集合不变，先裁决这一基本区间。
    flush(cursor, frame);

    // 应用该帧上的全部端点变动，再进入下一个基本区间。
    while (eventIndex < events.length && events[eventIndex].frame === frame) {
      const event = events[eventIndex];
      if (event.delta === 1) {
        active.add(event.clip.id);
      } else {
        active.delete(event.clip.id);
      }
      eventIndex += 1;
    }
    cursor = frame;
  }
  if (open) pieces.push(open);

  const segments: SourceReuseSegment[] = pieces.map((piece, index) => {
    const landings: SourceReuseLanding[] = piece.ids.map((id) => {
      const clip = clipById.get(id);
      if (!clip) {
        throw new Error(`来源复用审计引用了未知片段：${String(id)}`);
      }
      // 来源偏移按整数帧平移到该片段自己的 recordIn 上。
      const offsetIn = piece.start - clip.sourceIn.frame;
      const offsetOut = piece.end - clip.sourceIn.frame;
      if (offsetIn < 0 || offsetOut <= offsetIn || offsetOut > clip.durationFrames) {
        throw new Error('来源复用段落在片段来源区间之外');
      }
      const recordInFrame = clip.recordIn.frame + offsetIn;
      const recordOutFrame = clip.recordIn.frame + offsetOut;
      return {
        clipId: id,
        recordIn: toFrameTimecode(recordInFrame, rate),
        recordOut: toFrameTimecode(recordOutFrame, rate),
        durationFrames: recordOutFrame - recordInFrame
      };
    });

    return {
      index,
      sourceIn: toFrameTimecode(piece.start, rate),
      sourceOut: toFrameTimecode(piece.end, rate),
      durationFrames: piece.end - piece.start,
      coverageCount: piece.ids.length,
      coverageClipIds: piece.ids,
      landings
    };
  });

  const reusedSourceFrames = segments.reduce((sum, segment) => sum + segment.durationFrames, 0);
  const landingCount = segments.reduce((sum, segment) => sum + segment.coverageCount, 0);

  return {
    schemaVersion: 1,
    rate,
    dayFrames,
    segmentCount: segments.length,
    reusedSourceFrames,
    landingCount,
    segments
  };
}

export function buildSourceReuseReport(audit: SourceReuseAudit): SourceReuseReport {
  return { reportType: 'source-reuse-audit', ...audit };
}
