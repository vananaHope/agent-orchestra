/** 작업자 활동: Orca worker-list의 projection.stage.activity와 liveness에서 온다. */
export type Activity = 'working' | 'waiting' | 'idle' | 'none' | 'unknown'

export type Task = {
  /** `.local/orchestration/<name>/`의 작업 이름 */
  name: string
  /** state.md 첫 줄: 구현 중, 검토 중, 수정 중, 지시 대기, PR 열림 */
  phase: string
  /** state.md 둘째 줄의 등급·작업자 */
  tier?: string
  worker?: string
  /** state.md를 마지막으로 고친 시각(이 단계에 들어온 시각) */
  phaseSince: number
  activity: Activity
  /** Orca가 본 에이전트(claude, codex, opencode) */
  agent?: string
  /** 작업자 터미널 핸들(패널의 열기) */
  terminal?: string
  lastOutputAt?: number
}

/** 한 사용량 창. resets는 보여 줄 초기화 시각(`10-30 09:39`). */
export type Limit = { name: string; percent: number; resets?: string }

export type Snapshot = {
  at: number
  root: string | null
  tasks: Task[]
  limits: Limit[]
  /** Codex 한도를 마지막으로 잰 시각 */
  codexAt?: number
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-orchestra': {
      /** 이 세션에서 orchestrate-issues 스킬이 불렸다(지휘 세션) */
      isManager: boolean
      /** /orchestra-status off로 띠를 끔 */
      isBandOff: boolean
      snapshot: Shaped<Snapshot | null>
    }
  }
}
