import { describe, expect, it } from 'vitest';

import { slotOrder, sortBySlots, updateSlots, type PaneName, type Slot } from '../../src/renderer/slots';

const run = (steps: PaneName[][]): Slot[] => steps.reduce<Slot[]>((s, panes) => updateSlots(s, panes), []);

describe('updateSlots (card slot pinning)', () => {
  it('keeps first-seen order and appends new cards at the end, ignoring pane numbers', () => {
    const s = run([
      [{ paneId: '%9', name: 'ceo' }],
      [{ paneId: '%9', name: 'ceo' }, { paneId: '%12', name: 'pm' }],
      // main이 다른 순서로 보내도 자리 유지, 번호가 더 작은 새 칸도 맨 뒤
      [{ paneId: '%3', name: 'qa' }, { paneId: '%12', name: 'pm' }, { paneId: '%9', name: 'ceo' }],
    ]);
    expect(slotOrder(s)).toEqual(['%9', '%12', '%3']);
  });

  it('removes only the closed card and keeps the rest in place', () => {
    const s = run([
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%2', name: 'pm' }, { paneId: '%3', name: 'qa' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }],
    ]);
    expect(slotOrder(s)).toEqual(['%1', '%3']);
  });

  it('reuses the previous slot when a teammate with the same name comes back', () => {
    const s = run([
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%2', name: 'pm' }, { paneId: '%3', name: 'qa' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }, { paneId: '%7', name: 'pm' }],
    ]);
    expect(slotOrder(s)).toEqual(['%1', '%7', '%3']);
  });

  it('moves a card into the vacant same-name slot once its name is resolved', () => {
    const s = run([
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%2', name: 'pm' }, { paneId: '%3', name: 'qa' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }, { paneId: '%8', name: null }], // 매핑 전 %8
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%3', name: 'qa' }, { paneId: '%8', name: 'pm' }],
    ]);
    expect(slotOrder(s)).toEqual(['%1', '%8', '%3']);
    expect(s).toHaveLength(3);
  });

  it('a new unnamed card goes to the end and keeps its slot after naming when no vacancy exists', () => {
    const s = run([
      [{ paneId: '%1', name: 'ceo' }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%4', name: null }],
      [{ paneId: '%1', name: 'ceo' }, { paneId: '%4', name: 'designer' }, { paneId: '%5', name: 'qa' }],
    ]);
    expect(slotOrder(s)).toEqual(['%1', '%4', '%5']);
    expect(s[1].name).toBe('designer');
  });

  it('drops vacant slots without a name and does not mutate input', () => {
    const prev: Slot[] = [{ name: null, paneId: '%4' }, { name: 'ceo', paneId: '%1' }];
    const next = updateSlots(prev, [{ paneId: '%1', name: 'ceo' }]);
    expect(next).toEqual([{ name: 'ceo', paneId: '%1' }]);
    expect(prev[0].paneId).toBe('%4');
  });
});

describe('sortBySlots', () => {
  it('orders items by slot and leaves unknown ones at the end', () => {
    const slots: Slot[] = [{ name: 'a', paneId: '%5' }, { name: 'b', paneId: '%2' }];
    const items = [{ paneId: '%2' }, { paneId: '%9' }, { paneId: '%5' }];
    expect(sortBySlots(items, slots).map((x) => x.paneId)).toEqual(['%5', '%2', '%9']);
    expect(sortBySlots(items, undefined)).toBe(items);
  });
});
