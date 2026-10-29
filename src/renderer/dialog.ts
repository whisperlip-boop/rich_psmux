// 대화상자 공통 키 처리(확인 창·설정·세션 목록·앱 정보·칸 정보).

import { useEffect } from 'preact/hooks';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 맨 위(마지막) 대화상자 상자. */
function topDialog(): HTMLElement | null {
  const boxes = document.querySelectorAll<HTMLElement>('.modal .modal__box');
  return boxes[boxes.length - 1] ?? null;
}

/** 대화상자 안의 보이는 포커스 가능 요소(문서 순서). */
export function focusablesIn(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Tab/Shift+Tab 다음 포커스 대상(대화상자 안에서 순환). 순환이 필요 없으면(브라우저 기본 이동이 안에 머묾) null.
 *
 * Args:
 *   items: 대화상자 안 포커스 가능 요소.
 *   active: 현재 포커스 요소.
 *   back: Shift+Tab 여부.
 */
export function trapTarget(items: HTMLElement[], active: Element | null, back: boolean): HTMLElement | null {
  if (!items.length) return null;
  const i = active ? items.indexOf(active as HTMLElement) : -1;
  if (i < 0) return back ? items[items.length - 1] : items[0]; // 포커스가 밖에 있으면 안으로
  if (back && i === 0) return items[items.length - 1];
  if (!back && i === items.length - 1) return items[0];
  return null;
}

/**
 * 대화상자가 열려 있는 동안 창 어디서든 Esc로 닫고, Tab이 대화상자 안에서만 돌게 하며(M4-4),
 * 닫히면 열기 전 포커스 요소(아직 화면에 있으면)로 돌려준다(O-7).
 * Chromium은 나중에 그려진 autofocus를 무시하므로 열 때 포커스를 직접 옮긴다: focusSelector → [autofocus] → 첫 포커스 가능 요소.
 * 컴포넌트가 이미 안쪽으로 포커스를 옮겼으면(설정의 첫 입력) 건드리지 않는다.
 *
 * Args:
 *   open: 열림 여부.
 *   close: 닫기.
 *   focusSelector: 열릴 때 포커스할 요소.
 */
export function useDialogKeys(open: boolean, close: () => void, focusSelector?: string): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const box = topDialog();
    // 이 훅이 맡은 대화상자. 위에 다른 대화상자가 열려 있으면 키를 처리하지 않는다(리뷰 m-1: 중첩 시 Esc 한 번에 둘 다 닫힘)
    const mine = box;
    if (box && !box.contains(document.activeElement)) {
      const target = (focusSelector ? box.querySelector<HTMLElement>(focusSelector) : null)
        ?? box.querySelector<HTMLElement>('[autofocus]') ?? focusablesIn(box)[0] ?? null;
      target?.focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!mine || topDialog() !== mine) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const cur = topDialog();
      if (!cur) return;
      const items = focusablesIn(cur);
      const next = trapTarget(items, document.activeElement, e.shiftKey);
      if (next || !items.length) e.preventDefault();
      next?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // 확인 뒤 여는 버튼이 사라졌으면(이어가기 성공 등) 복귀하지 않는다
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
}
