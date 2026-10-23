// 지휘 상태를 읽어 내는 순수 함수들. register.tsx가 파일과 Orca 출력을 넘기고, 테스트도 여기를 본다.

import type { Activity, Limit, Task } from '../types'

/** 작업자가 붙어 있어야 하는 단계 */
export const ACTIVE_PHASES = ['구현 중', '검토 중', '수정 중'] as const
/** 사용자의 지시를 기다리는 단계 */
export const USER_PHASES = ['지시 대기', 'PR 열림'] as const
/** 병합까지 끝난 단계. 스냅숏에는 오늘 끝난 것만 남는다. */
export const DONE_PHASE = '끝'
/** 작업자가 쉬는데 단계가 그대로면 멈춤으로 보는 시간 */
export const PARKED_AFTER_MS = 5 * 60 * 1000

/** state.md: 첫 줄이 단계, 둘째 줄이 `등급: <등급> · 작업자: <표기>`. */
export function parseState(text: string): { phase: string; tier?: string; worker?: string } {
  const [first = '', second = ''] = text.replace(/^﻿/, '').split(/\r?\n/)
  const tier = /등급:\s*([^·]+?)\s*(?:·|$)/.exec(second)?.[1]
  const worker = /작업자:\s*(.+?)\s*$/.exec(second)?.[1]
  return { phase: first.trim(), ...(tier ? { tier } : {}), ...(worker ? { worker } : {}) }
}

/** worker-list의 한 줄 중 여기서 쓰는 부분 */
export type OrcaWorker = {
  dispatchId?: string
  workerState?: string
  dispatchStatus?: string
  agentTerminalHandle?: string
  terminalState?: string
  projection?: {
    workspace?: { id?: string }
    stage?: { activity?: string }
    liveness?: { verdict?: string }
    provider?: { id?: string | null }
  }
}

/** Orca 워크스페이스 id(`<repo>::<경로>`)의 마지막 폴더 이름 */
export function worktreeName(workspaceId: string | undefined): string | undefined {
  const path = workspaceId?.split('::').pop()
  return path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
}

/**
 * 작업의 작업자: worktree 이름이 `<작업 이름>` 또는 `<작업 이름>-<slug>`인 것 중 터미널이 남은 것.
 * 목록은 최신순이라, 지금 맡겨진(dispatched) 것을 먼저 고르고 없으면 가장 최근 것.
 */
export function workerOf(task: string, workers: readonly OrcaWorker[]): OrcaWorker | undefined {
  const mine = workers.filter(worker => {
    if (worker.terminalState === 'released') return false
    const name = worktreeName(worker.projection?.workspace?.id)
    return name === task || !!name?.startsWith(task + '-')
  })
  return mine.find(worker => worker.dispatchStatus === 'dispatched') ?? mine[0]
}

const SETTLED = ['succeeded', 'failed', 'stopped', 'abandoned', 'cancelled']

/** Orca가 훅으로 본 활동. 모르는 값은 짐작하지 않고 unknown으로 둔다. */
export function activityOf(worker: OrcaWorker | undefined): Activity {
  if (!worker) return 'none'
  const verdict = worker.projection?.liveness?.verdict
  if (verdict && verdict !== 'live') return 'unknown'
  const activity = worker.projection?.stage?.activity
  if (activity === 'working') return 'working'
  if (activity === 'waiting') return 'waiting'
  if (activity === 'idle' || activity === 'done') return 'idle'
  if (worker.dispatchStatus === 'completed' || SETTLED.includes(worker.workerState ?? '')) return 'idle'
  return 'unknown'
}

/** 작업 단계는 진행 중인데 작업자가 없거나 오래 쉬고 있다. */
export function isParked(task: Task, now: number): boolean {
  if (!(ACTIVE_PHASES as readonly string[]).includes(task.phase)) return false
  if (task.activity === 'none') return true
  return task.activity === 'idle' && now - (task.lastOutputAt ?? task.phaseSince) > PARKED_AFTER_MS
}

export type Counts = { 구현: number; 검토: number; 수정: number; waiting: number; parked: number; user: number }

export function countTasks(tasks: readonly Task[], now: number): Counts {
  const count = (phase: string) => tasks.filter(task => task.phase === phase).length
  return {
    구현: count('구현 중'), 검토: count('검토 중'), 수정: count('수정 중'),
    waiting: tasks.filter(task => task.activity === 'waiting').length,
    parked: tasks.filter(task => isParked(task, now)).length,
    user: tasks.filter(task => (USER_PHASES as readonly string[]).includes(task.phase)).length,
  }
}

/** codex_limit.py --json의 창들. 창 길이로 이름을 붙인다. */
export function codexLimits(json: unknown): Limit[] {
  const windows = (json as { windows?: unknown })?.windows
  if (!Array.isArray(windows)) return []
  return windows.flatMap((window: { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }) => {
    if (typeof window?.used_percent !== 'number') return []
    const minutes = typeof window.window_minutes === 'number' ? window.window_minutes : undefined
    const span = minutes === 300 ? '5h' : minutes === 10080 ? '7d' : minutes ? `${Math.round(minutes / 60)}h` : ''
    const resets = typeof window.resets_at === 'string' ? window.resets_at.slice(5) : undefined
    return [{ name: `Codex${span ? ' ' + span : ''}`, percent: window.used_percent, ...(resets ? { resets } : {}) }]
  })
}

/** `Codex 7d`·`Claude 5h`·`Claude 7d`를 공급자별로 묶는다: Claude 5h 3% 7d 11% */
export function limitGroups(limits: readonly Limit[]): { name: string; windows: (Limit & { span: string })[] }[] {
  const groups: { name: string; windows: (Limit & { span: string })[] }[] = []
  for (const limit of limits) {
    const [name = limit.name, span = ''] = limit.name.split(' ')
    const group = groups.find(item => item.name === name) ?? groups[groups.push({ name, windows: [] }) - 1]!
    group.windows.push({ ...limit, span })
  }
  return groups
}

/** 세션이 받은 Claude 사용량 창(five_hour, seven_day) */
export function claudeLimits(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return rateLimits.flatMap(limit => {
    const span = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? '7d' : undefined
    if (!span) return []
    return [{ name: `Claude ${span}`, percent: limit.percentUsed, ...(limit.resetsAt ? { resets: shortTime(Date.parse(limit.resetsAt)) } : {}) }]
  })
}

/** `10-30 09:39` (로컬 시각) */
export function shortTime(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `10/24` (로컬 날짜) */
export function monthDay(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

/** 둘이 같은 날(로컬)인가 */
export function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** 경과 시간: `40초`, `12분`, `2시간 5분` */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

export const ACTIVITY_LABEL: Record<Activity, { mark: string; word: string; color?: string }> = {
  working: { mark: '●', word: '일하는 중', color: 'success' },
  waiting: { mark: '◐', word: '입력 기다림', color: 'warning' },
  idle: { mark: '·', word: '쉬는 중' },
  none: { mark: '○', word: '작업자 없음' },
  unknown: { mark: '?', word: '모름' },
}

/** 터미널 칸 수: 한글·CJK·전각은 2칸 */
export function cols(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1
  }
  return width
}

/** 칸 수에 맞춰 자른다. 잘렸으면 끝에 `…` */
export function clip(text: string, width: number): string {
  if (cols(text) <= width) return text
  let out = ''
  for (const char of text) {
    if (cols(out + char) > width - 1) break
    out += char
  }
  return out + '…'
}

/** 사용률 막대: `███░░░░░░░` */
export function bar(percent: number, width: number): string {
  const size = Math.max(4, width)
  const filled = Math.min(size, Math.max(0, Math.round((percent / 100) * size)))
  return '█'.repeat(filled) + '░'.repeat(size - filled)
}

export type Group = 'attention' | 'running' | 'user'

/** 패널의 묶음: 지금 볼 것(입력 기다림·멈춤), 진행 중, 사용자 차례 */
export function groupOf(task: Task, now: number): Group {
  if (task.activity === 'waiting' || isParked(task, now)) return 'attention'
  return (USER_PHASES as readonly string[]).includes(task.phase) ? 'user' : 'running'
}

/** 먼저 봐야 할 것부터: 입력 기다림, 멈춤, 일하는 중, 사용자 차례, 나머지 */
export function byUrgency(tasks: readonly Task[], now: number): Task[] {
  const rank = (task: Task) => task.activity === 'waiting' ? 0 : isParked(task, now) ? 1 :
    task.activity === 'working' ? 2 : (USER_PHASES as readonly string[]).includes(task.phase) ? 4 : 3
  return [...tasks].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** 패널의 칸: 단계 순서(구현 중 → … → PR 열림), 모르는 단계는 그 뒤. 끝난 작업과 빈 칸은 뺀다. 칸 안은 급한 순서. */
export function phaseSections(tasks: readonly Task[], now: number): { phase: string; tasks: Task[] }[] {
  const known: string[] = [...ACTIVE_PHASES, ...USER_PHASES]
  const others = [...new Set(tasks.map(task => task.phase))].filter(phase => !known.includes(phase) && phase !== DONE_PHASE).sort()
  return [...known, ...others]
    .map(phase => ({ phase, tasks: byUrgency(tasks.filter(task => task.phase === phase), now) }))
    .filter(section => section.tasks.length)
}
