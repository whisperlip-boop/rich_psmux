// Agents 설정 대화상자: 팀 기능 상태, 에이전트 정의 목록(전역·프로젝트), 리더 선택(리드 명령 저장), 팀원 대조, 안내.
// 읽기 전용 조사 결과만 보여 주고, 저장하는 것은 앱 설정의 리드 명령뿐이다(~/.claude 는 쓰지 않음).

import { useEffect, useState } from 'preact/hooks';

import type { AgentEntryDto, AgentsDto } from '../../shared/api';
import { useDialogKeys } from '../dialog';
import { t, tx } from '../i18n';
import { safeIpc } from '../ipc';

interface AgentsDialogProps {
  /** 활성 탭(그 작업 폴더의 프로젝트 정의도 읽음). 없으면 전역만. */
  tabId: string | null;
  onClose: () => void;
  /** 리더를 저장했을 때(새 리드 명령). */
  onSaved: (leadCommand: string) => void;
}

/** 직접 지정(목록에 없는 리드 명령) 선택 값. */
const CUSTOM = '\u0000custom';

/** 리더로 고를 수 있는 정의(형식 오류 제외, 같은 이름은 프로젝트 정의가 먼저). */
export function selectableAgents(agents: AgentEntryDto[]): AgentEntryDto[] {
  const seen = new Set<string>();
  return agents.filter((a) => {
    if (a.error || !a.name || seen.has(a.name.toLowerCase())) return false;
    seen.add(a.name.toLowerCase());
    return true;
  });
}

/** 이름으로 정의 찾기(대소문자 무시, 앞(프로젝트) 우선). */
export function findAgent(list: AgentEntryDto[], name: string): AgentEntryDto | undefined {
  const key = name.toLowerCase();
  return list.find((a) => a.name?.toLowerCase() === key);
}

/**
 * 드롭다운 처음 선택값: 리드 명령의 이름을 대소문자 무시로 찾은 정의 이름에 맞춘다.
 * 정의가 없으면 그 이름 그대로("(정의 없음)" 항목), 직접 지정 명령이면 null.
 */
export function initialSelection(list: AgentEntryDto[], leadName: string | null): string | null {
  if (!leadName) return null;
  return findAgent(list, leadName)?.name ?? leadName;
}

/**
 * 판정: 리더 있음 + 참조 팀원 전부 있음 + 팀 기능 켜짐 → 빈 배열("사용 가능"), 아니면 항목별 안내.
 *
 * Args:
 *   data: 조사 결과.
 *   selected: 고른 리더 이름(직접 지정이면 null).
 */
export function agentIssues(data: AgentsDto, selected: string | null): string[] {
  const issues: string[] = [];
  if (!data.teams.enabled) issues.push(t('agents.teamsOff'));
  const list = selectableAgents(data.agents);
  if (!list.length) issues.push(t('agents.noDefs'));
  if (selected === null) issues.push(t('agents.customLead'));
  else {
    const leader = findAgent(list, selected);
    // 상한(200)에 걸려 읽지 못한 정의가 있으면 "없음"이라고 단정하지 않는다
    if (!leader) issues.push(t(data.truncated ? 'agents.leaderTrunc' : 'agents.leaderMissing', { name: selected }));
    else if (leader.missing.length) {
      // 이름 목록은 파일 이름이라 언어와 무관하게 ', '로 잇는다
      issues.push(t(data.truncated ? 'agents.refTrunc' : 'agents.refMissing', { names: leader.missing.join(', ') }));
    }
  }
  return issues;
}

/** Agents 설정 대화상자. */
export function AgentsDialog({ tabId, onClose, onSaved }: AgentsDialogProps) {
  const [data, setData] = useState<AgentsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<string>(CUSTOM);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useDialogKeys(true, onClose, 'select, .modal__actions .btn-secondary');

  useEffect(() => {
    void safeIpc(() => window.ctd.listAgents(tabId), null).then((d) => {
      if (!d) {
        setFailed(true);
        return;
      }
      setData(d);
      setSel(initialSelection(selectableAgents(d.agents), d.leadName) ?? CUSTOM);
    });
  }, []);
  // 처음 열 때는 목록을 읽기 전이라 [닫기]에 포커스가 간다 → 읽고 나면 리더 선택으로 옮긴다(사용자가 다른 곳으로 옮겼으면 그대로)
  useEffect(() => {
    if (!data) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || a.closest('.agents .modal__actions')) document.querySelector<HTMLElement>('#agents-lead')?.focus();
  }, [data]);

  const list = data ? selectableAgents(data.agents) : [];
  const selected = sel === CUSTOM ? null : sel;
  const issues = data ? agentIssues(data, selected) : [];
  const errors = data ? data.agents.filter((a) => a.error) : [];
  const leaderInList = !!selected && !!findAgent(list, selected);
  const showGuide = !!data && (!list.length || !leaderInList || errors.length > 0);
  // 처음 선택값(대소문자를 정의에 맞춘 이름)과 다를 때만 저장 가능
  const changed = !!data && selected !== null && selected !== initialSelection(list, data.leadName);

  const save = async (): Promise<void> => {
    if (!selected || saving) return;
    setSaving(true);
    const r = await safeIpc(() => window.ctd.setLeadAgent(selected), { ok: false, error: t('agents.saveFailed') } as { ok: boolean; error?: string; leadCommand?: string });
    setSaving(false);
    if (!r.ok || !r.leadCommand) {
      setMsg(r.error ?? t('agents.saveFailed'));
      return;
    }
    setData({ ...data!, leadCommand: r.leadCommand, leadName: selected });
    setMsg(t('agents.saved'));
    onSaved(r.leadCommand);
  };
  const copy = async (): Promise<void> => {
    const ok = await safeIpc(() => window.ctd.copyAgentTemplate(), false);
    setMsg(t(ok ? 'agents.copied' : 'agents.copyFailed'));
  };

  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box agents" role="dialog" aria-modal="true" aria-label={t('agents.title')} onClick={(e) => e.stopPropagation()}>
        <h2>{t('agents.title')}</h2>
        {failed && <p class="field__error">{t('agents.readFailed')}</p>}
        {!data && !failed && <p class="muted">{t('agents.reading')}</p>}
        {data && (
          <>
            <div class={`agents__verdict${issues.length ? ' is-warn' : ' is-ok'}`} role="status">
              {issues.length ? (
                <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
              ) : <span>{t('agents.ok')}</span>}
            </div>
            <p class="agents__teams">
              <span class="agents__k">{t('agents.teams')}</span>
              {data.teams.enabled
                ? <span>{t('agents.teamsOn', { source: data.teams.source ?? '' })}</span>
                : <span>{t('agents.teamsOffHelp')}</span>}
            </p>
            {data.teams.teammateMode && (
              <p class="agents__teams">
                <span class="agents__k">teammateMode</span>
                <span>{data.teams.teammateMode}{data.teams.teammateMode === 'in-process' ? t('agents.inProcess') : ''}</span>
              </p>
            )}
            <div class="field agents__lead">
              <label for="agents-lead">{t('agents.leader')}</label>
              <div class="agents__row">
                <select id="agents-lead" value={sel} onChange={(e) => { setSel((e.target as HTMLSelectElement).value); setMsg(null); }}>
                  {list.map((a) => <option key={`${a.scope}:${a.name}`} value={a.name!}>{a.scope === 'project' ? t('agents.optProject', { name: a.name! }) : a.name}</option>)}
                  {data.leadName && !findAgent(list, data.leadName) && (
                    <option value={data.leadName}>{t(data.truncated ? 'agents.optUnverifiable' : 'agents.optNoDef', { name: data.leadName })}</option>
                  )}
                  {!data.leadName && <option value={CUSTOM}>{t('agents.optCustom', { cmd: data.leadCommand })}</option>}
                </select>
                <button class="btn-primary" disabled={!changed || saving} onClick={() => void save()}>{t(saving ? 'agents.savingLeader' : 'agents.saveLeader')}</button>
              </div>
              <span class="field__hint">{t('agents.leaderHint')}</span>
            </div>
            {msg && <p class="agents__msg" role="status">{msg}</p>}
            <h3 class="agents__h">{t(data.truncated ? 'agents.defsTrunc' : 'agents.defs', { n: data.agents.length })}</h3>
            {data.agents.length ? (
              <ul class="agents__list">
                {data.agents.map((a) => (
                  <li key={`${a.scope}:${a.file}`} class={a.error ? 'is-error' : undefined}>
                    <span class="agents__scope">{t(a.scope === 'project' ? 'agents.scopeProject' : 'agents.scopeGlobal')}</span>
                    {a.error
                      ? <span class="agents__err">{a.error}: {a.file}</span>
                      : <span class="agents__line"><b>{a.name}</b>{a.description ? ` — ${a.description}` : ''}</span>}
                  </li>
                ))}
              </ul>
            ) : <p class="muted">{t(data.projectDir ? 'agents.noFilesProject' : 'agents.noFiles')}</p>}
            {showGuide && (
              <div class="agents__guide">
                <p><b>{t('agents.guideTitle')}</b></p>
                <p>{tx('agents.guide', {
                  global: <code>{`~/.claude/agents/<${t('agents.phName')}>.md`}</code>,
                  project: <code>{`<${t('agents.phProject')}>/.claude/agents/<${t('agents.phName')}>.md`}</code>,
                  dashes: <code>---</code>, name: <code>name:</code>, desc: <code>description:</code>, mention: <code>@pm</code>,
                })}</p>
                <div class="agents__guide-actions">
                  <button class="btn-secondary" onClick={() => void copy()}>{t('agents.copyTemplate')}</button>
                  <button class="btn-secondary" onClick={() => void safeIpc(() => window.ctd.openAgentsFolder(), false)}>{t('agents.openFolder')}</button>
                </div>
              </div>
            )}
          </>
        )}
        <div class="modal__actions">
          <button class="btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
