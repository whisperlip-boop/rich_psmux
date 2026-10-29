import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYOUT, DEFAULT_MAIN_RATIO, DEFAULT_TAB_UI, LAYOUTS, clampMainRatio, getMainRatio, isMainLayout, layoutFromCode, layoutTooltip,
  normalizeLayout, ratioFromKey, ratioFromPointer, splitLead, tabTitles, tiledGrid, withMainRatio, type TabUi,
} from '../../src/renderer/layout';

describe('layout selector 1~5', () => {
  it('defines tmux layouts in order with main-horizontal default', () => {
    expect(LAYOUTS.map((l) => l.name)).toEqual(['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled']);
    expect(DEFAULT_LAYOUT).toBe(3);
    expect(layoutTooltip(3)).toBe('main-horizontal — Ctrl+Shift+3');
  });
  it('maps Ctrl+Shift+1~5 key codes (Shift changes e.key, so code is used)', () => {
    expect(layoutFromCode('Digit1')).toBe(1);
    expect(layoutFromCode('Numpad5')).toBe(5);
    expect(layoutFromCode('Digit6')).toBeNull();
    expect(layoutFromCode('KeyA')).toBeNull();
  });
  it('normalizes old/invalid stored values to the default', () => {
    expect(normalizeLayout('cols2')).toBe(3);
    expect(normalizeLayout(4)).toBe(4);
    expect(normalizeLayout(7)).toBe(3);
  });
  it('tiled: cols = ceil(sqrt n), rows = ceil(n / cols)', () => {
    expect(tiledGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(tiledGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(tiledGrid(5)).toEqual({ cols: 3, rows: 2 });
    expect(tiledGrid(10)).toEqual({ cols: 4, rows: 3 });
    expect(tiledGrid(0)).toEqual({ cols: 1, rows: 1 });
  });
  it('puts the lead in the main slot and keeps the rest in slot order', () => {
    expect(splitLead(['%4', '%1', '%2'], '%1')).toEqual({ main: '%1', rest: ['%4', '%2'] });
    expect(splitLead(['%4', '%2'], '%1')).toEqual({ main: null, rest: ['%4', '%2'] });
    expect(splitLead(['%1'], '%1')).toEqual({ main: '%1', rest: [] });
  });
});

describe('main split ratio (분할 경계선)', () => {
  it('defaults to 50% for both main layouts', () => {
    expect(DEFAULT_MAIN_RATIO).toBe(50);
    expect(getMainRatio(DEFAULT_TAB_UI, 3)).toBe(50);
    expect(getMainRatio(DEFAULT_TAB_UI, 4)).toBe(50);
  });
  it('only layouts 3 and 4 have a split handle', () => {
    expect(([1, 2, 3, 4, 5] as const).filter(isMainLayout)).toEqual([3, 4]);
  });
  it('clamps to 25~75% and falls back to 50% for invalid values', () => {
    expect(clampMainRatio(10)).toBe(25);
    expect(clampMainRatio(90)).toBe(75);
    expect(clampMainRatio(35.04)).toBe(35);
    expect(clampMainRatio(NaN)).toBe(50);
    expect(clampMainRatio('60')).toBe(50);
    expect(clampMainRatio(undefined)).toBe(50);
  });
  it('stores layout 3 and 4 ratios separately without touching other fields', () => {
    const a = withMainRatio(DEFAULT_TAB_UI, 3, 35);
    expect(a.mainRatio).toEqual({ 3: 35, 4: 50 });
    const b = withMainRatio(a, 4, 70);
    expect(b.mainRatio).toEqual({ 3: 35, 4: 70 });
    expect(withMainRatio(b, 3, 99).mainRatio[3]).toBe(75);
    expect(DEFAULT_TAB_UI.mainRatio).toEqual({ 3: 50, 4: 50 }); // 기본값 객체는 바뀌지 않음
    const ui: TabUi = { layout: 4, activePane: '%2', mainRatio: { 3: 40, 4: 60 } };
    expect(withMainRatio(ui, 4, 30)).toEqual({ layout: 4, activePane: '%2', mainRatio: { 3: 40, 4: 30 } });
  });
  it('treats a missing/corrupt stored ratio as 50%', () => {
    const old = { layout: 3, activePane: null } as unknown as TabUi;
    expect(getMainRatio(old, 3)).toBe(50);
    expect(withMainRatio(old, 4, 40).mainRatio).toEqual({ 3: 50, 4: 40 });
  });
  it('maps pointer position to ratio with the handle centred on the pointer', () => {
    // 내용 영역 start 100, 길이 1012, 경계선 12 → 나눌 길이 1000
    expect(ratioFromPointer(100 + 500 + 6, 100, 1012, 12)).toBe(50);
    expect(ratioFromPointer(100 + 350 + 6, 100, 1012, 12)).toBe(35);
    expect(ratioFromPointer(0, 100, 1012, 12)).toBe(25);
    expect(ratioFromPointer(5000, 100, 1012, 12)).toBe(75);
    expect(ratioFromPointer(300, 100, 10, 12)).toBe(50); // 영역이 경계선보다 작음
  });
  it('keyboard: arrows move 2%, Home resets to 50%, other keys ignored', () => {
    expect(ratioFromKey('ArrowUp', 50)).toBe(48);
    expect(ratioFromKey('ArrowLeft', 50)).toBe(48);
    expect(ratioFromKey('ArrowDown', 50)).toBe(52);
    expect(ratioFromKey('ArrowRight', 50)).toBe(52);
    expect(ratioFromKey('ArrowUp', 26)).toBe(25);
    expect(ratioFromKey('ArrowRight', 74.5)).toBe(75);
    expect(ratioFromKey('Home', 70)).toBe(50);
    expect(ratioFromKey('Enter', 50)).toBeNull();
  });
});

describe('tabTitles', () => {
  it('numbers duplicate folder names', () => {
    expect(tabTitles(['D:\\a\\win_memory', 'C:\\x\\Win_Memory\\', 'D:\\b'])).toEqual(['win_memory', 'Win_Memory (2)', 'b']);
  });
});
