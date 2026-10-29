import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutputBatcher } from '../../src/main/psmux/outputBatcher';

describe('OutputBatcher (flush order around resync)', () => {
  let events: string[];
  let b: OutputBatcher;
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    b = new OutputBatcher((pane, data) => events.push(`out ${pane} ${data.toString()}`), 16);
  });
  afterEach(() => vi.useRealTimers());

  it('batches per pane and flushes after the delay', () => {
    b.push('%1', Buffer.from('a'), 1);
    b.push('%1', Buffer.from('b'), 2);
    b.push('%2', Buffer.from('x'), 3);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(events).toEqual(['out %1 ab', 'out %2 x']);
  });

  it('emits output older than the capture before the resync and newer output after it', () => {
    b.push('%1', Buffer.from('old1'), 10);
    b.push('%1', Buffer.from('old2'), 11);
    b.push('%2', Buffer.from('other'), 12);
    b.push('%1', Buffer.from('new'), 14); // 캡처 응답 블록(seq 13) 뒤에 도착
    // sessionManager.resync 순서: flushBefore → emit('resync')
    b.flushBefore('%1', 13);
    events.push('resync %1');
    vi.advanceTimersByTime(16);
    expect(events).toEqual(['out %1 old1old2', 'resync %1', 'out %1 new', 'out %2 other']);
  });

  it('inserts a late cursor chunk at its stream position', () => {
    b.push('%1', Buffer.from('old'), 10);
    b.flushBefore('%1', 13); // 캡처(13) 응답 직후
    events.push('resync %1');
    b.push('%1', Buffer.from('mid'), 14); // 캡처와 커서 응답(15) 사이 출력
    b.push('%1', Buffer.from('late'), 16); // 커서 응답 뒤 출력이 같은 청크에서 먼저 들어옴
    b.push('%1', Buffer.from('[CUR]'), 15);
    vi.advanceTimersByTime(16);
    expect(events).toEqual(['out %1 old', 'resync %1', 'out %1 mid[CUR]late']);
  });

  it('flushBefore with nothing pending is a no-op and drop discards a pane', () => {
    b.flushBefore('%9', 100);
    b.push('%3', Buffer.from('z'), 1);
    b.drop('%3');
    vi.advanceTimersByTime(16);
    expect(events).toEqual([]);
  });
});
