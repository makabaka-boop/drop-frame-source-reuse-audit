// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import App from '../App';
import { REUSE_SAMPLE_INPUT } from '../sample';

/**
 * 页面联动验收：
 * - 来源复用段卡片 / 来源轴段可点选；
 * - 选中后来源段与录制时间线上的“全部落点”同时高亮，再次点击取消；
 * - 无效编辑保留两套旧视图并标记旧结论过期；
 * - 新有效输入原子替换两套视图并清掉选择；
 * - 两份下载各自独立：核对 JSON 不含复用审计，复用报告单独成文。
 */

if (typeof SVGElement !== 'undefined' && !SVGElement.prototype.scrollIntoView) {
  SVGElement.prototype.scrollIntoView = function scrollIntoView() {};
}
if (typeof HTMLDivElement !== 'undefined' && !HTMLDivElement.prototype.scrollIntoView) {
  HTMLDivElement.prototype.scrollIntoView = function scrollIntoView() {};
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;
let anchorClick: () => number;
let createdAnchors: HTMLAnchorElement[];
let blobs: Blob[];

beforeEach(() => {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  createdAnchors = [];
  blobs = [];
  anchorClick = vi.fn();

  const NativeBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class BlobSpy extends NativeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        blobs.push(this);
      }
    }
  );

  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
    const element = originalCreateElement(tagName);
    if (tagName === 'a') {
      createdAnchors.push(element as HTMLAnchorElement);
      vi.spyOn(element as HTMLAnchorElement, 'click').mockImplementation(function clickMock() {
        anchorClick();
      });
    }
    return element;
  });

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:reuse-test'),
    revokeObjectURL: vi.fn()
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function flush() {
  act(() => {
    // 让 React 18 的调度与 effect 落盘。
  });
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`找不到按钮：${text}`);
  return button as HTMLButtonElement;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('source reuse audit page linkage', () => {
  it('highlights the source segment and every record landing on click, then clears', () => {
    act(() => {
      root.render(<App />);
    });
    flush();

    // 切到无缝合版、存在来源复用的示例。
    click(getButtonByText('复用示例'));

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual(JSON.parse(REUSE_SAMPLE_INPUT));

    // 无缝合版：旧接缝结论为零断点，但复用审计报告两段复用。
    expect(container.textContent).toContain('未发现空隙或重叠');
    expect(container.textContent).toContain('2 段');
    expect(container.querySelectorAll('article[data-testid^="reuse-card-"]')).toHaveLength(2);

    // 初始没有任何落点高亮。
    expect(container.querySelectorAll('.reuse-landing-highlight')).toHaveLength(0);

    // 通过来源轴上的第一段发起点选。
    const sourceSegment = container.querySelector(
      '[data-testid="reuse-source-segment-0"]'
    ) as SVGRectElement;
    expect(sourceSegment).toBeTruthy();
    click(sourceSegment);

    // 来源段自身高亮。
    expect(sourceSegment.classList.contains('reuse-source-segment-selected')).toBe(true);
    // 对应卡片同步进入选中态。
    const card0 = container.querySelector('[data-testid="reuse-card-0"]') as HTMLElement;
    expect(card0.classList.contains('reuse-card-selected')).toBe(true);
    // 该段被 A、C 两片覆盖：录制轴上同时高亮两个落点。
    let landings = container.querySelectorAll('[data-testid^="reuse-landing-0-"]');
    expect(landings).toHaveLength(2);
    for (const landing of landings) {
      expect(landing.classList.contains('reuse-landing-highlight')).toBe(true);
    }

    // 点卡片按钮切到第二段：旧落点消失，新段（B、D）两个落点出现。
    click(container.querySelector('[data-testid="reuse-card-button-1"]') as HTMLButtonElement);
    expect(container.querySelectorAll('[data-testid^="reuse-landing-0-"]')).toHaveLength(0);
    landings = container.querySelectorAll('[data-testid^="reuse-landing-1-"]');
    expect(landings).toHaveLength(2);

    // 点任意一个录制落点也能取消选择（双向联动）。
    click(container.querySelector('[data-testid="reuse-landing-1-0"]') as SVGRectElement);
    expect(container.querySelectorAll('.reuse-landing-highlight')).toHaveLength(0);
    expect(container.querySelectorAll('.reuse-source-segment-selected')).toHaveLength(0);
  });

  it('keeps stale views marked expired on invalid edits and atomically swaps both views on recovery', () => {
    act(() => {
      root.render(<App />);
    });
    click(getButtonByText('复用示例'));

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    // 选中一段，建立联动证据。
    click(container.querySelector('[data-testid="reuse-source-segment-1"]') as SVGRectElement);
    expect(container.querySelectorAll('[data-testid^="reuse-landing-1-"]')).toHaveLength(2);

    // 非法编辑：两套视图都保留，但标记旧结论过期。
    setTextareaValue(textarea, '{ not valid json');
    expect(container.textContent).toContain('整份输入已拒绝');
    expect(container.textContent).toContain('旧接缝结论已过期');
    expect(container.textContent).toContain('基于上次合法结果');
    // 导出按钮在非法期间禁用。
    expect(getButtonByText('导出核对 JSON').disabled).toBe(true);
    expect(getButtonByText('下载复用报告').disabled).toBe(true);

    // 恢复为另一组合法输入（单片）：两套视图原子替换，选择被清空。
    setTextareaValue(
      textarea,
      JSON.stringify({
        rate: '30000/1001',
        clips: [
          { id: 'X', sourceIn: '01:00:00;00', sourceOut: '01:00:02;00', recordIn: '00:00:00;00' }
        ]
      })
    );
    expect(container.textContent).not.toContain('整份输入已拒绝');
    expect(container.querySelectorAll('.reuse-landing-highlight')).toHaveLength(0);
    expect(container.querySelectorAll('.reuse-source-segment-selected')).toHaveLength(0);
    // 单片无复用：审计段为零，但面板仍在。
    expect(container.textContent).toContain('未发现来源帧复用');
    expect(getButtonByText('导出核对 JSON').disabled).toBe(false);
    expect(getButtonByText('下载复用报告').disabled).toBe(false);
  });

  it('downloads the original check JSON unchanged and the reuse report separately', async () => {
    act(() => {
      root.render(<App />);
    });
    click(getButtonByText('复用示例'));

    click(getButtonByText('导出核对 JSON'));
    click(getButtonByText('下载复用报告'));
    expect(anchorClick).toHaveBeenCalledTimes(2);

    expect(blobs).toHaveLength(2);
    const [analysisText, reuseText] = await Promise.all(blobs.map((blob) => blob.text()));
    const analysis = JSON.parse(analysisText);
    const reuse = JSON.parse(reuseText);

    // 旧 JSON 导出逐项不变：键集合与 schemaVersion 保持原样，不含复用字段。
    expect(Object.keys(analysis).sort()).toEqual(
      ['breaks', 'clips', 'dayFrames', 'firstBreak', 'rate', 'schemaVersion'].sort()
    );
    expect(analysis.schemaVersion).toBe(1);
    expect(analysis).not.toHaveProperty('sourceReuse');
    expect(analysis).not.toHaveProperty('reuse');
    expect(analysis.breaks).toHaveLength(0);

    // 复用报告单独成文。
    expect(reuse.reportType).toBe('source-reuse-audit');
    expect(reuse.schemaVersion).toBe(1);
    expect(reuse.segmentCount).toBe(2);
    expect(reuse.segments).toHaveLength(2);
    expect(reuse.segments[0].coverageClipIds).toEqual(['A', 'C']);
    expect(reuse.segments[1].coverageClipIds).toEqual(['B', 'D']);
    expect(
      reuse.segments[0].landings.map((l: { recordIn: { frame: number } }) => l.recordIn.frame)
    ).toEqual([150, 750]);
    expect(
      reuse.segments[1].landings.map((l: { recordIn: { frame: number } }) => l.recordIn.frame)
    ).toEqual([600, 1050]);
    expect(reuse.segments[0].landings[0].clipId).toBe('A');
    expect(reuse.segments[0].durationFrames).toBe(150);
    expect(reuse.segments[1].durationFrames).toBe(150);

    // 下载文件名也相互独立。
    expect(createdAnchors.map((anchor) => anchor.download)).toEqual([
      'dropframe-check-30000_1001.json',
      'source-reuse-audit-30000_1001.json'
    ]);
  });
});
