/** 작업자 활동: Orca worker-list의 projection.stage.activity와 liveness에서 온다. */
export type Activity = 'working' | 'waiting' | 'idle' | 'none' | 'unknown'

export type Task = {
  /** `.local/orchestration/<name>/`의 작업 이름 */
  name: string
  /** state.md 첫 줄: 구현 중, 검토 중, 수정 중, 지시 대기, PR 열림, 끝(오늘 끝난 것만) */
  phase: string
  /** state.md 둘째 줄의 등급·작업자 */
  tier?: string
  worker?: string
  /** state.md의 `막힘: <풀릴 조건>` 줄: 관리자가 적은, 이 작업이 기다리는 것 */
  blocker?: string
  /** state.md를 마지막으로 고친 시각(이 단계에 들어온 시각) */
  phaseSince: number
  activity: Activity
  /** Orca가 본 에이전트(claude, codex, opencode) */
  agent?: string
  /** 작업자 터미널 핸들(패널의 열기) */
  terminal?: string
  lastOutputAt?: number
}

/** 맡길 이슈의 상태: 바로 맡길 수 있음, 선행 이슈를 기다림, 막힘(재개 조건이 따로 있음) */
export type FrontierStatus = 'ready' | 'waiting' | 'blocked'

/** `.local/orchestration/frontier.json`의 한 줄: 관리자가 1단계에서 쓴다. 패널은 읽기만 한다. */
export type FrontierIssue = {
  /** 작업 이름(`issue-21`) */
  name: string
  title?: string
  status: FrontierStatus
  /** waiting: 기다리는 선행 작업 이름들 */
  needs?: string[]
  /** blocked: 무엇이 풀려야 하는지 */
  blocker?: string
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
  /** frontier.json의 맡길 이슈와 그 파일을 마지막으로 고친 시각(파일이 없으면 둘 다 없음) */
  frontier?: FrontierIssue[]
  frontierAt?: number
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
