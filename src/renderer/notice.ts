// 오류 배너 상태(TC-180): 메시지와 "그래도 이어가기" 대상을 하나로 묶는다. 새 오류는 항상 통째로 교체해,
// 이전 이어가기 대상이 다른 오류 배너에 남지 않게 한다. 순수 로직(단위 테스트 대상).

/** 오류 배너 상태. */
export interface ErrorNotice {
  message: string;
  /** "그래도 이어가기" 대상 대화 ID(실행 중으로 보여 거부된 이어가기에서만). */
  forceSid: string | null;
}

/**
 * 새 배너 상태. 메시지가 없으면 배너 없음(null). 이어가기 대상은 명시한 경우에만 붙는다.
 *
 * Args:
 *   message: 한국어 안내(없으면 배너 닫기).
 *   forceSid: 그래도 이어가기 대상(기본 없음).
 */
export function errorNotice(message: string | null | undefined, forceSid: string | null = null): ErrorNotice | null {
  return message ? { message, forceSid } : null;
}
