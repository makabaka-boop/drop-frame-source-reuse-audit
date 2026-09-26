export const SAMPLE_INPUT = JSON.stringify(
  {
    rate: '30000/1001',
    clips: [
      {
        id: 'A',
        sourceIn: '01:00:00;00',
        sourceOut: '01:00:05;00',
        recordIn: '00:10:00;00'
      },
      {
        id: 'B',
        sourceIn: '02:00:00;00',
        sourceOut: '02:00:05;00',
        recordIn: '00:10:05;00'
      },
      {
        id: 'C',
        sourceIn: '03:00:00;00',
        sourceOut: '03:00:05;00',
        recordIn: '00:10:11;00'
      },
      {
        id: 'D',
        sourceIn: '04:00:00;00',
        sourceOut: '04:00:05;00',
        recordIn: '00:10:15;00'
      }
    ]
  },
  null,
  2
);

/**
 * 合版核对场景：录制时间线首尾相接、没有任何缝隙，
 * 但 A/C 与 B/D 各自重复引用了同一段来源画面，需要来源复用审计才能发现。
 */
export const REUSE_SAMPLE_INPUT = JSON.stringify(
  {
    rate: '30000/1001',
    clips: [
      {
        id: 'A',
        sourceIn: '01:00:00;00',
        sourceOut: '01:00:10;00',
        recordIn: '00:00:00;00'
      },
      {
        id: 'B',
        sourceIn: '02:00:00;00',
        sourceOut: '02:00:15;00',
        recordIn: '00:00:10;00'
      },
      {
        id: 'C',
        sourceIn: '01:00:05;00',
        sourceOut: '01:00:15;00',
        recordIn: '00:00:25;00'
      },
      {
        id: 'D',
        sourceIn: '02:00:10;00',
        sourceOut: '02:00:25;00',
        recordIn: '00:00:35;00'
      }
    ]
  },
  null,
  2
);
