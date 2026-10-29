// Claude Code statusLine 명령으로 실행되는 사용량 기록기(F7-1). stdin JSON에서 rate_limits(5시간·7일 사용률·재설정 시각)와
// 받은 시각만 앱 데이터 폴더의 usage.json에 원자적으로 기록한다. 비용·세션 ID·cwd·모델 등 다른 필드는 기록하지 않는다.
// stdout에는 아무것도 쓰지 않는다(statusline 표시 없음). 어떤 경우에도 exit 0으로 끝나 Claude 동작을 막지 않는다.
// 사용: <node|electron(ELECTRON_RUN_AS_NODE=1)> statusLine.js <usage.json 경로>

import { writeUsageAtomicSync } from '../main/usageFile';
import { parseStatusLineInput } from '../shared/usage';

/** stdin 상한. 실제 statusline JSON은 수 KB라 넘으면 기록하지 않고 끝낸다(잘린 JSON을 해석하지 않음). */
const MAX_INPUT = 1024 * 1024;
/** stdin이 끝나지 않을 때 보호 종료 시간. */
const GUARD_MS = 15000;

const out = process.argv[2];
const chunks: Buffer[] = [];
let size = 0;
setTimeout(() => process.exit(0), GUARD_MS);
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (d: Buffer) => {
  size += d.length;
  if (size > MAX_INPUT) process.exit(0);
  chunks.push(d);
});
process.stdin.on('end', () => {
  const rec = parseStatusLineInput(Buffer.concat(chunks).toString('utf8'), Date.now());
  if (out && rec) {
    try {
      writeUsageAtomicSync(out, rec);
    } catch { /* 기록 실패가 Claude 동작을 막지 않게 무시 */ }
  }
  process.exit(0);
});
