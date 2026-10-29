// Claude Code hook에서 실행되는 기록기. stdin JSON에서 상태 판단용 필드만 골라 앱 폴더 파일에 한 줄 추가한다.
// 본문(prompt, tool_input, last_assistant_message)·경로(transcript_path, cwd)는 기록하지 않는다.
// stdout에는 아무것도 쓰지 않는다(hook 결정을 내리지 않음 = Claude Code 기본 동작 유지).
// 사용: <node|electron(ELECTRON_RUN_AS_NODE=1)> hookRecorder.js <출력 파일>

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => { buf += d; });
process.stdin.on('end', () => {
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(buf) as Record<string, unknown>; } catch { /* 형식 오류: 이벤트 이름 없이 버림 */ }
  const s = (k: string, n = 80): string | undefined => (typeof j[k] === 'string' ? (j[k] as string).slice(0, n) : undefined);
  if (out && typeof j.hook_event_name === 'string') {
    const rec = {
      t: Date.now(),
      event: s('hook_event_name'),
      sid: s('session_id', 36),
      // psmux가 칸 프로세스에 넣는 칸 ID. claude → hook 프로세스로 상속됨(칸 매핑 1순위)
      pane: process.env.TMUX_PANE,
      agentType: s('agent_type'),
      teammateName: s('teammate_name'),
      notificationType: s('notification_type'),
      toolName: s('tool_name'),
    };
    try {
      mkdirSync(dirname(out), { recursive: true });
      appendFileSync(out, JSON.stringify(rec) + '\n');
    } catch { /* 기록 실패가 Claude 동작을 막지 않게 무시 */ }
  }
  process.exit(0);
});
