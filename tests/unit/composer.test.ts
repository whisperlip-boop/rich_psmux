import { describe, expect, it } from 'vitest';

import { INPUT_LINE_HEIGHT, INPUT_MAX_HEIGHT, inputHeight } from '../../src/renderer/composer';

describe('composer input auto height (bug: empty input stuck at 2 lines over the terminal)', () => {
  it('resets an empty input to one line regardless of the measured height', () => {
    expect(inputHeight('', 70)).toBeNull();
    expect(inputHeight('', 16)).toBeNull();
  });
  it('uses the measured height for text, clamped to 1 line ~ max', () => {
    expect(inputHeight('a', 34)).toBe(INPUT_LINE_HEIGHT);
    expect(inputHeight('a', 16)).toBe(INPUT_LINE_HEIGHT);
    expect(inputHeight('a\nb', 52)).toBe(52);
    expect(inputHeight('a\nb', 51.4)).toBe(52);
    expect(inputHeight('x'.repeat(500), 400)).toBe(INPUT_MAX_HEIGHT);
  });
  it('falls back to one line when measured while hidden', () => {
    expect(inputHeight('a\nb', 0)).toBe(INPUT_LINE_HEIGHT);
    expect(inputHeight('a', Number.NaN)).toBe(INPUT_LINE_HEIGHT);
  });
});
