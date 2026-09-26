import { describe, expect, it } from 'vitest';
import { analyzeInput, ClipId } from './analysis';
import { formatFrame } from './timecode';
import {
  SourceReuseAudit,
  buildSourceReuseReport,
  computeSourceReuseAudit
} from './reuse';
import type { DropFrameRate } from './timecode';

type Rate = DropFrameRate;

const RATE_30: Rate = '30000/1001';
const DAY_30 = 2_589_408;

interface RawClipSpec {
  id: ClipId;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
}

function clipFromFrames(spec: RawClipSpec, rate: Rate = RATE_30) {
  return {
    id: spec.id,
    sourceIn: formatFrame(spec.sourceIn, rate),
    sourceOut: formatFrame(spec.sourceOut, rate),
    recordIn: formatFrame(spec.recordIn, rate)
  };
}

function auditFromSpecs(specs: RawClipSpec[], rate: Rate = RATE_30): SourceReuseAudit {
  const response = analyzeInput({ rate, clips: specs.map((spec) => clipFromFrames(spec, rate)) });
  if (!response.ok) {
    throw new Error(response.issues.map((issue) => issue.message).join('; '));
  }
  return computeSourceReuseAudit(response.result);
}

interface ExpectedPiece {
  start: number;
  end: number;
  ids: ClipId[];
}

/**
 * 逐帧成员集合预言机：对来源轴上的每一帧枚举覆盖它的片段 id 集合，
 * 把“集合相同且大小 ≥ 2”的连续帧压成最大半开区间。
 * 集合的任何变化（哪怕覆盖计数相同）都必须断开。
 */
function oracle(specs: RawClipSpec[]): ExpectedPiece[] {
  const endMax = Math.max(...specs.map((spec) => spec.sourceOut));
  const membersAt = (frame: number): ClipId[] =>
    specs
      .slice()
      .sort(
        (a, b) =>
          a.recordIn - b.recordIn
          || (a.sourceOut - a.sourceIn) - (b.sourceOut - b.sourceIn)
          || specs.indexOf(a) - specs.indexOf(b)
      )
      .filter((spec) => spec.sourceIn <= frame && frame < spec.sourceOut)
      .map((spec) => spec.id);

  const pieces: ExpectedPiece[] = [];
  let runStart: number | null = null;
  let runIds: ClipId[] = [];
  let previousIds: ClipId[] | null = null;

  for (let frame = 0; frame < Math.max(endMax, 1); frame += 1) {
    const ids = membersAt(frame);
    const sameAsPrevious =
      previousIds !== null && ids.length === previousIds.length && ids.every((id, i) => id === previousIds![i]);
    previousIds = ids;

    if (ids.length >= 2 && sameAsPrevious) {
      // 延续当前游程。
      continue;
    }
    if (runStart !== null) {
      pieces.push({ start: runStart, end: frame, ids: runIds });
      runStart = null;
    }
    if (ids.length >= 2) {
      runStart = frame;
      runIds = ids;
    }
  }
  if (runStart !== null) {
    pieces.push({ start: runStart, end: endMax, ids: runIds });
  }
  // 过滤掉与 dayFrames 无关的空轴情形，保持与被测函数同样按起点排序。
  return pieces.filter((piece) => piece.end > piece.start).sort((a, b) => a.start - b.start);
}

function expectedLanding(spec: RawClipSpec, piece: ExpectedPiece) {
  const recordIn = spec.recordIn + (piece.start - spec.sourceIn);
  const recordOut = spec.recordIn + (piece.end - spec.sourceIn);
  return { clipId: spec.id, recordIn, recordOut, durationFrames: recordOut - recordIn };
}

function expectSegmentsMatch(audit: SourceReuseAudit, specs: RawClipSpec[], dayFrames: number, rate: Rate = RATE_30) {
  const expected = oracle(specs);
  expect(audit.segments.map((segment) => [segment.sourceIn.frame, segment.sourceOut.frame])).toEqual(
    expected.map((piece) => [piece.start, piece.end])
  );

  let reusedFrames = 0;
  let landings = 0;
  audit.segments.forEach((segment, i) => {
    const piece = expected[i];
    expect(segment.sourceIn.frame).toBe(piece.start);
    expect(segment.sourceOut.frame).toBe(piece.end);
    expect(segment.sourceIn.timecode).toBe(formatFrame(piece.start, rate));
    expect(segment.sourceOut.timecode).toBe(formatFrame(piece.end, rate));
    expect(segment.durationFrames).toBe(piece.end - piece.start);
    expect(segment.coverageCount).toBe(piece.ids.length);
    expect(segment.coverageClipIds).toEqual(piece.ids);
    expect(segment.landings).toHaveLength(piece.ids.length);

    piece.ids.forEach((id, landingIndex) => {
      const spec = specs.find((item) => item.id === id);
      if (!spec) throw new Error(`预言机缺少片段 ${String(id)}`);
      const landing = segment.landings[landingIndex];
      const expectedLandingValue = expectedLanding(spec, piece);
      expect(landing.clipId).toBe(expectedLandingValue.clipId);
      expect(landing.recordIn.frame).toBe(expectedLandingValue.recordIn);
      expect(landing.recordOut.frame).toBe(expectedLandingValue.recordOut);
      expect(landing.recordIn.timecode).toBe(formatFrame(expectedLandingValue.recordIn, rate));
      expect(landing.recordOut.timecode).toBe(formatFrame(expectedLandingValue.recordOut, rate));
      expect(landing.durationFrames).toBe(piece.end - piece.start);
      // 录制落点全部位于日内，不触碰日末回绕点。
      expect(landing.recordOut.frame).toBeLessThan(dayFrames);
      landings += 1;
    });
    reusedFrames += piece.end - piece.start;
  });

  expect(audit.segmentCount).toBe(expected.length);
  expect(audit.reusedSourceFrames).toBe(reusedFrames);
  expect(audit.landingCount).toBe(landings);
}

describe('source reuse audit — endpoint sweep', () => {
  it('finds no reuse for a single clip or disjoint sources', () => {
    const single = auditFromSpecs([{ id: 'A', sourceIn: 100, sourceOut: 200, recordIn: 0 }]);
    expect(single.segments).toEqual([]);
    expect(single.segmentCount).toBe(0);
    expect(single.reusedSourceFrames).toBe(0);
    expect(single.landingCount).toBe(0);

    const disjoint = auditFromSpecs([
      { id: 'A', sourceIn: 0, sourceOut: 10, recordIn: 0 },
      { id: 'B', sourceIn: 10, sourceOut: 20, recordIn: 10 },
      { id: 'C', sourceIn: 30, sourceOut: 40, recordIn: 20 }
    ]);
    expect(disjoint.segments).toEqual([]);
  });

  it('reports the intersection for containment and crossing intervals', () => {
    const containment = auditFromSpecs([
      { id: 'long', sourceIn: 0, sourceOut: 300, recordIn: 0 },
      { id: 'short', sourceIn: 60, sourceOut: 240, recordIn: 900 }
    ]);
    expectSegmentsMatch(containment, [
      { id: 'long', sourceIn: 0, sourceOut: 300, recordIn: 0 },
      { id: 'short', sourceIn: 60, sourceOut: 240, recordIn: 900 }
    ], DAY_30);

    const crossing = auditFromSpecs([
      { id: 'A', sourceIn: 0, sourceOut: 180, recordIn: 0 },
      { id: 'B', sourceIn: 120, sourceOut: 300, recordIn: 500 }
    ]);
    expectSegmentsMatch(crossing, [
      { id: 'A', sourceIn: 0, sourceOut: 180, recordIn: 0 },
      { id: 'B', sourceIn: 120, sourceOut: 300, recordIn: 500 }
    ], DAY_30);
  });

  it('splits a triple overlap into maximal pieces by the active id set', () => {
    const specs = [
      { id: 'A', sourceIn: 0, sourceOut: 300, recordIn: 0 },
      { id: 'B', sourceIn: 60, sourceOut: 240, recordIn: 1_000 },
      { id: 'C', sourceIn: 120, sourceOut: 180, recordIn: 2_000 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(3);
    expect(audit.segments.map((segment) => segment.coverageClipIds)).toEqual([
      ['A', 'B'],
      ['A', 'B', 'C'],
      ['A', 'B']
    ]);
    expect(audit.segments.map((segment) => [segment.sourceIn.frame, segment.sourceOut.frame])).toEqual([
      [60, 120],
      [120, 180],
      [180, 240]
    ]);
    // 首尾两段活动集合相同（{A,B}），但中间夹过三重覆盖，仍然必须断开。
    expect(audit.segments[0]).not.toBe(audit.segments[2]);
    expectSegmentsMatch(audit, specs, DAY_30);
  });

  it('breaks when the active set changes even if the coverage count stays two', () => {
    const specs = [
      { id: 'A', sourceIn: 0, sourceOut: 180, recordIn: 0 },
      { id: 'B', sourceIn: 0, sourceOut: 120, recordIn: 1_000 },
      { id: 'C', sourceIn: 120, sourceOut: 180, recordIn: 2_000 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(2);
    expect(audit.segments.map((segment) => segment.coverageCount)).toEqual([2, 2]);
    expect(audit.segments.map((segment) => segment.coverageClipIds)).toEqual([
      ['A', 'B'],
      ['A', 'C']
    ]);
    expect(audit.segments[0].sourceOut.frame).toBe(audit.segments[1].sourceIn.frame);
    expectSegmentsMatch(audit, specs, DAY_30);
  });

  it('keeps two disjoint reused regions separated by single-coverage frames as separate segments', () => {
    // B 是 [0,300) 的长片；A1 引用 [30,90)、A2 引用 [200,260)。
    // 两个复用区活动集合不同（{A1,B} 与 {A2,B}），且中间夹着只有 B 的帧，
    // 两段必须保持独立，不能跨低覆盖区间合并。
    const specs = [
      { id: 'B', sourceIn: 0, sourceOut: 300, recordIn: 0 },
      { id: 'A1', sourceIn: 30, sourceOut: 90, recordIn: 1_000 },
      { id: 'A2', sourceIn: 200, sourceOut: 260, recordIn: 2_000 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(2);
    expect(audit.segments.map((segment) => [segment.sourceIn.frame, segment.sourceOut.frame])).toEqual([
      [30, 90],
      [200, 260]
    ]);
    expect(audit.reusedSourceFrames).toBe(120);
    expectSegmentsMatch(audit, specs, DAY_30);
  });

  it('treats touching endpoints as no reuse but keeps adjacent maximal pieces distinct', () => {
    // 半开 [0,120) 与 [120,240) 在帧 120 处不相会。
    const touching = auditFromSpecs([
      { id: 'A', sourceIn: 0, sourceOut: 120, recordIn: 0 },
      { id: 'B', sourceIn: 120, sourceOut: 240, recordIn: 120 }
    ]);
    expect(touching.segments).toEqual([]);

    // C 包住两段：[0,120) 是 {A,C}，[120,240) 是 {B,C}，集合不同即使相邻也断开。
    const specs = [
      { id: 'A', sourceIn: 0, sourceOut: 120, recordIn: 0 },
      { id: 'B', sourceIn: 120, sourceOut: 240, recordIn: 120 },
      { id: 'C', sourceIn: 0, sourceOut: 240, recordIn: 3_000 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(2);
    expect(audit.segments.map((segment) => segment.coverageClipIds)).toEqual([
      ['A', 'C'],
      ['B', 'C']
    ]);
    expectSegmentsMatch(audit, specs, DAY_30);
  });

  it('keeps numeric id 1 and string id "1" as separate coverage identities', () => {
    const specs: RawClipSpec[] = [
      { id: 1, sourceIn: 0, sourceOut: 150, recordIn: 0 },
      { id: '1', sourceIn: 30, sourceOut: 150, recordIn: 900 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(1);
    const segment = audit.segments[0];
    expect(segment.coverageCount).toBe(2);
    expect(segment.coverageClipIds).toEqual([1, '1']);
    expect(segment.landings.map((landing) => [typeof landing.clipId, landing.clipId])).toEqual([
      ['number', 1],
      ['string', '1']
    ]);
    expect(segment.landings[0].recordIn.frame).toBe(30);
    expect(segment.landings[1].recordIn.frame).toBe(900);
    expectSegmentsMatch(audit, specs, DAY_30);

    const roundTripped = JSON.parse(JSON.stringify(audit)) as SourceReuseAudit;
    expect(roundTripped.segments[0].coverageClipIds).toEqual([1, '1']);
    expect(roundTripped.segments[0].landings[0].clipId).toBe(1);
    expect(roundTripped.segments[0].landings[1].clipId).toBe('1');
  });

  it('handles identical source intervals referenced by many clips at separate record positions', () => {
    const specs = [
      { id: 'a', sourceIn: 500, sourceOut: 650, recordIn: 10_000 },
      { id: 'b', sourceIn: 500, sourceOut: 650, recordIn: 0 },
      { id: 'c', sourceIn: 500, sourceOut: 650, recordIn: 5_000 }
    ];
    const audit = auditFromSpecs(specs);
    expect(audit.segments).toHaveLength(1);
    const segment = audit.segments[0];
    expect([segment.sourceIn.frame, segment.sourceOut.frame]).toEqual([500, 650]);
    expect(segment.coverageCount).toBe(3);
    // 按录制位置排列：b(0) → c(5000) → a(10000)。
    expect(segment.coverageClipIds).toEqual(['b', 'c', 'a']);
    expect(segment.landings.map((landing) => landing.recordIn.frame)).toEqual([0, 5_000, 10_000]);
    expect(audit.reusedSourceFrames).toBe(150);
    expect(audit.landingCount).toBe(3);
  });

  it('maps every landing through that clips own recordIn with integer frame offsets', () => {
    const specs = [
      { id: 'A', sourceIn: 1_000, sourceOut: 2_000, recordIn: 100 },
      { id: 'B', sourceIn: 1_500, sourceOut: 2_500, recordIn: 80_000 }
    ];
    const audit = auditFromSpecs(specs);
    const segment = audit.segments[0];
    expect([segment.sourceIn.frame, segment.sourceOut.frame]).toEqual([1_500, 2_000]);
    expect(segment.landings[0].recordIn.frame).toBe(600);
    expect(segment.landings[0].recordOut.frame).toBe(1_100);
    expect(segment.landings[1].recordIn.frame).toBe(80_000);
    expect(segment.landings[1].recordOut.frame).toBe(80_500);
    expect(segment.durationFrames).toBe(500);
  });

  it('supports reuse right up to the day-end source label without wrap and works at 59.94', () => {
    const specs30: RawClipSpec[] = [
      { id: 'A', sourceIn: DAY_30 - 300, sourceOut: DAY_30 - 1, recordIn: 0 },
      { id: 'B', sourceIn: DAY_30 - 100, sourceOut: DAY_30 - 1, recordIn: 400 }
    ];
    const audit30 = auditFromSpecs(specs30, RATE_30);
    expect(audit30.segments).toHaveLength(1);
    const segment30 = audit30.segments[0];
    expect(segment30.sourceOut.frame).toBe(DAY_30 - 1);
    expect(segment30.sourceOut.timecode).toBe('23:59:59;29');
    expect(segment30.sourceOut.frame).toBeLessThan(DAY_30);

    const day60 = 5_178_816;
    const specs60: RawClipSpec[] = [
      { id: 'A', sourceIn: day60 - 600, sourceOut: day60 - 1, recordIn: 0 },
      { id: 'B', sourceIn: day60 - 200, sourceOut: day60 - 1, recordIn: 800 }
    ];
    const audit60 = auditFromSpecs(specs60, '60000/1001');
    expect(audit60.rate).toBe('60000/1001');
    expect(audit60.segments[0].sourceOut.timecode).toBe('23:59:59;59');
    expect(audit60.segments[0].sourceOut.frame).toBeLessThan(day60);
    expectSegmentsMatch(audit60, specs60, day60, '60000/1001');
  });

  it('agrees with the per-frame membership oracle on random interval sets', () => {
    let seed = 0x1234_abcd;
    const random = () => {
      // 确定性 LCG，避免引入随机源。
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return seed / 2 ** 32;
    };

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const clipCount = 1 + Math.floor(random() * 6);
      const specs: RawClipSpec[] = [];
      for (let i = 0; i < clipCount; i += 1) {
        const sourceIn = Math.floor(random() * 50);
        const length = 1 + Math.floor(random() * 20);
        const sourceOut = Math.min(60, sourceIn + length);
        const duration = sourceOut - sourceIn;
        // 保证 recordOut < dayFrames，recordIn 留出时长空间。
        const recordIn = Math.floor(random() * 1_000);
        specs.push({ id: `c${i}`, sourceIn, sourceOut, recordIn });
        // 避开日末拒绝（这里的 recordIn 远小于 dayFrames，仅做自检）。
        expect(recordIn + duration).toBeLessThan(DAY_30);
      }
      const audit = auditFromSpecs(specs);
      expectSegmentsMatch(audit, specs, DAY_30);
    }
  });

  it('exposes a serializable report separate from the original analysis snapshot', () => {
    const specs = [
      { id: 'A', sourceIn: 0, sourceOut: 100, recordIn: 0 },
      { id: 'B', sourceIn: 50, sourceOut: 100, recordIn: 500 }
    ];
    const response = analyzeInput({ rate: RATE_30, clips: specs.map((spec) => clipFromFrames(spec)) });
    if (!response.ok) throw new Error(response.issues[0]?.message);
    const audit = computeSourceReuseAudit(response.result);
    const report = buildSourceReuseReport(audit);

    const parsedReport = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsedReport.reportType).toBe('source-reuse-audit');
    expect(parsedReport.schemaVersion).toBe(1);
    expect(parsedReport.segments).toHaveLength(1);

    // 原核对结果 JSON 不含复用审计字段，旧导出逐项不变。
    const parsedAnalysis = JSON.parse(JSON.stringify(response.result)) as Record<string, unknown>;
    expect(parsedAnalysis).not.toHaveProperty('sourceReuse');
    expect(parsedAnalysis).not.toHaveProperty('reuse');
    expect(parsedAnalysis.schemaVersion).toBe(1);
    expect(Object.keys(parsedAnalysis).sort()).toEqual(
      ['breaks', 'clips', 'dayFrames', 'firstBreak', 'rate', 'schemaVersion'].sort()
    );
  });
});
