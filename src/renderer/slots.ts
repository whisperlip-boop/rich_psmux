// 카드 자리 고정: 앱이 처음 본 순서 유지, 새 카드는 맨 뒤, 사라진 카드만 빠짐,
// 같은 이름 팀원이 다시 생기면 이전 자리 재사용. pane 번호·이름으로 재정렬하지 않는다. 순수 로직(단위 테스트 대상).

/** 카드 자리 하나. paneId가 null이면 빈 자리(이름이 있을 때만 남겨 재사용). */
export interface Slot {
  name: string | null;
  paneId: string | null;
}

/** 현재 칸과 확정된 이름(매핑 전이면 null). */
export interface PaneName {
  paneId: string;
  name: string | null;
}

/**
 * 칸 목록 변화를 자리 목록에 반영한다.
 *
 * Args:
 *   prev: 이전 자리 목록(탭별).
 *   panes: 현재 칸(새 칸이 여러 개면 이 순서대로 뒤에 붙음).
 *
 * Returns:
 *   새 자리 목록(prev는 바꾸지 않음).
 */
export function updateSlots(prev: Slot[], panes: PaneName[]): Slot[] {
  const present = new Map(panes.map((p) => [p.paneId, p.name]));
  let slots: Slot[] = prev
    .map((s) => (s.paneId && !present.has(s.paneId) ? { name: s.name, paneId: null } : { ...s }))
    .filter((s) => s.paneId !== null || s.name !== null); // 이름 없는 빈 자리는 재사용할 수 없으니 버림
  const vacantFor = (name: string): Slot | undefined => slots.find((s) => s.paneId === null && s.name === name);

  // 기존 자리: 이름이 새로 확정됐는데 같은 이름의 빈 자리가 있으면 그 자리로 옮김(이전 자리 재사용)
  for (const s of [...slots]) {
    if (!s.paneId) continue;
    const name = present.get(s.paneId) ?? null;
    if (name === null || name === s.name) continue;
    const v = s.name === null ? vacantFor(name) : undefined;
    if (v) {
      v.paneId = s.paneId;
      slots = slots.filter((x) => x !== s);
    } else {
      s.name = name;
    }
  }
  // 새 칸: 같은 이름 빈 자리 → 없으면 맨 뒤
  const placed = new Set(slots.map((s) => s.paneId).filter((x): x is string => !!x));
  for (const p of panes) {
    if (placed.has(p.paneId)) continue;
    const v = p.name !== null ? vacantFor(p.name) : undefined;
    if (v) v.paneId = p.paneId;
    else slots.push({ name: p.name, paneId: p.paneId });
    placed.add(p.paneId);
  }
  return slots;
}

/** 자리 순서대로 칸 ID 목록. */
export function slotOrder(slots: Slot[]): string[] {
  return slots.map((s) => s.paneId).filter((x): x is string => !!x);
}

/** 자리 순서로 정렬(자리에 없는 칸은 원래 순서로 뒤에). */
export function sortBySlots<T extends { paneId: string }>(items: T[], slots: Slot[] | undefined): T[] {
  if (!slots) return items;
  const idx = new Map(slotOrder(slots).map((id, i) => [id, i]));
  return [...items].sort((a, b) => (idx.get(a.paneId) ?? 1e9) - (idx.get(b.paneId) ?? 1e9));
}
