// 카드 입력창 자동 높이. 순수 로직(단위 테스트 대상).

/** 1줄 높이 = line-height 18 + 위아래 padding 8×2(styles.css `.composer textarea`와 같은 값). */
export const INPUT_LINE_HEIGHT = 34;
/** 최대 높이(약 6줄). 넘치면 입력창 안에서 스크롤. */
export const INPUT_MAX_HEIGHT = 132;

/**
 * 입력창 높이를 정한다. 빈 값은 측정하지 않고 1줄로 되돌린다(placeholder 줄바꿈·전환 중 측정값이 남지 않게).
 *
 * Args:
 *   value: 입력창 현재 값.
 *   scrollHeight: `height: auto`로 되돌린 뒤 읽은 scrollHeight.
 *
 * Returns:
 *   지정할 높이(px). null이면 인라인 높이를 지워 CSS 기본(1줄)을 쓴다.
 */
export function inputHeight(value: string, scrollHeight: number): number | null {
  if (value === '') return null;
  // 숨겨진 탭 등에서 측정값이 0이면 1줄로 두고, 보일 때 크기 변경으로 다시 잰다
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return INPUT_LINE_HEIGHT;
  return Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_LINE_HEIGHT, Math.ceil(scrollHeight)));
}
