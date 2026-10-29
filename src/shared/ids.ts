// main·renderer 공용 식별자 규칙.

/** Claude Code 대화 ID(uuid) 형식. 명령에 붙이거나 IPC로 받기 전 검증용. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
