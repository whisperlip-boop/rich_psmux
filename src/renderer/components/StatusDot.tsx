// 상태 표시: 색만으로 구분하지 않고 모양(● ○ ◐ ! ✕) + aria-label을 함께 쓴다.

import type { MsgKey } from '../../shared/i18n';
import { t } from '../i18n';

/** 상태 종류. */
export type StatusKind = 'working' | 'idle' | 'detached' | 'approval' | 'disconnected';

const LABEL: Record<StatusKind, MsgKey> = {
  working: 'status.working', idle: 'status.idle', detached: 'status.detached', approval: 'status.approval', disconnected: 'status.disconnected',
};

/** 상태 점. */
export function StatusDot({ kind }: { kind: StatusKind }) {
  return (
    <span class={`sdot sdot--${kind}`} role="img" aria-label={t(LABEL[kind])} title={t(LABEL[kind])}>
      {kind === 'approval' ? '!' : kind === 'disconnected' ? '✕' : ''}
    </span>
  );
}

/** 상태 이름(툴팁용). */
export function statusLabel(kind: StatusKind): string {
  return t(LABEL[kind]);
}
