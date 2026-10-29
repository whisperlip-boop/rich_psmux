// IPC 호출 보호: main 처리기가 예외를 던지면 invoke가 reject되어 await 뒤 상태 복구(busy·sending 해제 등)가 건너뛰어진다.
// 호출부에서 실패를 대체값으로 바꿔 흐름을 이어가고, 사용자에게는 현재 언어 안내를 띄운다(콘솔·로그는 영어).

import { tr } from '../shared/i18n';

/**
 * IPC 호출을 실행하고 reject·동기 예외를 fallback으로 바꾼다.
 *
 * Args:
 *   call: IPC 호출(동기 예외도 잡기 위해 함수로 받는다).
 *   fallback: 실패 시 돌려줄 값.
 *   onError: 실패 안내(없으면 콘솔만).
 *   what: 안내 문구에 쓸 작업 이름(현재 언어, 예: tr('action.openSession')).
 *
 * Returns:
 *   호출 결과 또는 fallback.
 */
export async function safeIpc<T>(call: () => Promise<T>, fallback: T, onError?: (msg: string) => void, what = tr('action.request')): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ipc] call failed: ${msg}`);
    onError?.(tr('ipc.failed', { what, msg }));
    return fallback;
  }
}
