// 언어 선택 대화상자(계정 ⋯ 메뉴 "언어"): 검색창 + 3열 그리드(네이티브 이름 굵게 / 영어 이름 회색). 항목을 누르면 바로 적용·저장하고 닫힌다.
// 키 처리(Esc 닫기·Tab 순환·닫으면 연 버튼으로 포커스 복귀)는 다른 대화상자와 같은 useDialogKeys.

import { useState } from 'preact/hooks';

import { filterLangs, langTag, type Lang } from '../../shared/i18n';
import { useDialogKeys } from '../dialog';
import { t, uiFontStack } from '../i18n';

interface LanguageDialogProps {
  /** 지금 언어(✓ 표시). */
  current: Lang;
  /** 언어를 골랐을 때(적용·저장은 호출부). */
  onPick: (lang: Lang) => void;
  onClose: () => void;
}

/** 언어 선택 대화상자. */
export function LanguageDialog({ current, onPick, onClose }: LanguageDialogProps) {
  const [query, setQuery] = useState('');
  // 열리면 검색창에 포커스(Esc는 검색어가 있어도 대화상자를 닫는다)
  useDialogKeys(true, onClose, '.lang__search input');
  const list = filterLangs(query);

  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box lang" role="dialog" aria-modal="true" aria-labelledby="lang-title" onClick={(e) => e.stopPropagation()}>
        <div class="lang__head">
          <h2 id="lang-title">{t('lang.title')}</h2>
          <button class="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </div>
        <div class="search lang__search">
          <svg class="search__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" placeholder={t('lang.search')} aria-label={t('lang.search')} spellcheck={false} value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        {list.length ? (
          <div class="lang__grid" role="group" aria-label={t('lang.title')}>
            {list.map((l) => {
              const on = l.code === current;
              return (
                <button key={l.code} class={`lang__item${on ? ' is-selected' : ''}`} aria-pressed={on} lang={langTag(l.code)}
                  title={`${l.native} — ${l.english}`} style={{ fontFamily: uiFontStack(l) }} onClick={() => onPick(l.code)}>
                  <span class="lang__names">
                    <span class="lang__native">{l.native}</span>
                    <span class="lang__english" lang="en">{l.english}</span>
                  </span>
                  {on && (
                    <svg class="lang__check" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 8.5l3.2 3L13 4.5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p class="lang__empty" role="status">{t('common.noResults', { q: query.trim() })}</p>
        )}
      </div>
    </div>
  );
}
