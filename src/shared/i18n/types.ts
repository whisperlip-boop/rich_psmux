// 사전 타입. 키 집합은 원문 사전(ko.ts) 기준이라 다른 언어 사전의 누락·오타는 컴파일 오류가 된다.

import type { ko } from './ko';

/** 복수형 문구: Intl.PluralRules가 고른 범주의 문구를 쓴다(그 언어에 있는 범주만, other는 필수). 수는 {n}. */
export interface PluralEntry {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** 사전 값: 문자열 또는 복수형. */
export type Entry = string | PluralEntry;
/** 문구 키. */
export type MsgKey = keyof typeof ko;
/** 언어별 사전(모든 키 필수). 복수형 여부는 원문 사전과 같아야 한다(테스트로 검사). */
export type Dict = Record<MsgKey, Entry>;
/** 보간 값: 문자열·숫자(Intl.NumberFormat으로 표시), 또는 나중에 번역할 문구(Msg, 언어를 바꾸면 다시 번역됨). */
export type Param = string | number | Msg;
/** 번역을 미뤄 둔 문구(상태로 오래 남는 안내용: 탭 오류·사용량 오류·셸 경고). */
export interface Msg {
  key: MsgKey;
  params?: Record<string, Param>;
}
