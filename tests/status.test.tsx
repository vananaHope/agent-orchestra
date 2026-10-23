import type { On } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import type { Snapshot, Task } from '../types'
import { activityOf, codexLimits, countTasks, isParked, parseState, workerOf } from '../hooks/model.ts'
import type { OrcaWorker } from '../hooks/model.ts'

/** 세션이 저장해 둔 값처럼 상태를 넣는다(엔진 자리의 state.get 훅). */
function seed(on: On, state: { isManager?: boolean; snapshot?: Snapshot }) {
  on('clock.now', () => ({ value: NOW }))
  on('ui.panes', () => ({ value: [] }))
  on('state.get', (_, e) => {
    const key = (e as { key?: string }).key
    if (key === 'isManager' && state.isManager !== undefined) return { value: { value: state.isManager, version: 1 } }
    if (key === 'snapshot' && state.snapshot) return { value: { value: { shape: 'snapshot-2', value: state.snapshot }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
}

const MINUTE = 60 * 1000
const NOW = Date.parse('2026-10-24T10:00:00Z')

const worker = (path: string, activity: string, extra: Partial<OrcaWorker> = {}): OrcaWorker => ({
  dispatchId: path, dispatchStatus: 'dispatched', terminalState: 'active', agentTerminalHandle: `term-${path}`,
  projection: { workspace: { id: `repo::C:/w/${path}` }, stage: { activity }, liveness: { verdict: 'live' }, provider: { id: 'codex' } },
  ...extra,
})

const task = (name: string, phase: string, activity: Task['activity'], extra: Partial<Task> = {}): Task =>
  ({ name, phase, activity, phaseSince: NOW - 10 * MINUTE, ...extra })

test('state.md의 단계와 등급·작업자를 읽는다', () => {
  expect(parseState('검토 중\n등급: standard · 작업자: codex@high+fast\n')).toEqual({ phase: '검토 중', tier: 'standard', worker: 'codex@high+fast' })
  expect(parseState('\uFEFF구현 중\r\n')).toEqual({ phase: '구현 중' })
})

test('작업 이름으로 worktree의 작업자를 찾고, 비슷한 번호는 섞지 않는다', () => {
  const workers = [worker('issue-250-dialog', 'working'), worker('issue-25-fix', 'waiting'), worker('issue-7', 'working', { terminalState: 'released' })]
  expect(workerOf('issue-25', workers)?.dispatchId).toBe('issue-25-fix')
  expect(workerOf('issue-250', workers)?.dispatchId).toBe('issue-250-dialog')
  expect(workerOf('issue-7', workers)).toBe(undefined)
})

test('Orca가 본 활동을 옮기고, 모르는 값은 짐작하지 않는다', () => {
  expect(activityOf(worker('a', 'working'))).toBe('working')
  expect(activityOf(worker('a', 'waiting'))).toBe('waiting')
  expect(activityOf(undefined)).toBe('none')
  expect(activityOf(worker('a', 'something-new'))).toBe('unknown')
  expect(activityOf({ ...worker('a', 'working'), projection: { liveness: { verdict: 'lost' } } })).toBe('unknown')
})

test('진행 단계인데 작업자가 없거나 오래 쉬면 멈춤이다', () => {
  expect(isParked(task('a', '구현 중', 'none'), NOW)).toBe(true)
  expect(isParked(task('a', '구현 중', 'idle', { lastOutputAt: NOW - 2 * MINUTE }), NOW)).toBe(false)
  expect(isParked(task('a', '구현 중', 'idle', { lastOutputAt: NOW - 6 * MINUTE }), NOW)).toBe(true)
  expect(isParked(task('a', '지시 대기', 'none'), NOW)).toBe(false)
})

test('codex_limit.py의 창 길이로 이름을 붙인다', () => {
  const json = { status: 'ok', windows: [{ used_percent: 6, window_minutes: 10080, resets_at: '2026-10-30 09:39' }] }
  expect(codexLimits(json)).toEqual([{ name: 'Codex 7d', percent: 6, resets: '10-30 09:39' }])
  expect(codexLimits({ status: 'unknown' })).toEqual([])
})

test('개수를 단계와 활동별로 센다', () => {
  const counts = countTasks([task('a', '구현 중', 'working'), task('b', '검토 중', 'waiting'), task('c', '지시 대기', 'idle')], NOW)
  expect(counts).toEqual({ 구현: 1, 검토: 1, 수정: 0, waiting: 1, parked: 0, user: 1 })
})

const BAND = {
  plugin: 'agent-orchestra',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const PANE = {
  plugin: 'agent-orchestra',
  component: 'Pane',
  requestId: 'orchestra-status',
  props: { title: '지휘 상태', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SNAP: Snapshot = {
  at: NOW, root: 'C:/repo',
  tasks: [
    task('issue-12', '구현 중', 'working', { worker: 'codex@high' }), task('issue-13', '검토 중', 'waiting', { worker: 'claude' }),
    task('issue-9', '지시 대기', 'idle'), task('issue-8', '끝', 'idle'),
  ],
  limits: [{ name: 'Codex 7d', percent: 6, resets: '10-30 09:39' }, { name: 'Claude 5h', percent: 85 }],
  errors: [],
}

test('지휘 세션이 아니면 띠를 그리지 않는다', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  seed(on, { snapshot: SNAP })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('지휘 세션의 띠는 단계·입력 대기·한도를 한 줄로 보여 준다', async ($, on) => {
  seed(on, { isManager: true, snapshot: SNAP })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /구현 1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /issue-13 입력 대기/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /지시 대기 1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5h 85%/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('끝난 작업은 띠의 개수에 넣지 않는다', async ($, on) => {
  seed(on, { isManager: true, snapshot: { ...SNAP, tasks: [task('issue-8', '끝', 'idle')] } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /진행 중인 작업 없음/ })).toBeTruthy()
  await ui.unmount()
})

test('패널은 오늘 할 일 수 아래 진행중과 완료를 날짜와 함께 보여 준다', async ($, on) => {
  seed(on, { isManager: true, snapshot: SNAP })
  const day = `${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}/${String(new Date(NOW).getDate()).padStart(2, '0')}`
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /오늘 할 일 4/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^진행중$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^완료$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /issue-13.*입력 기다림/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /issue-12.*구현 중/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✓ issue-8/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: day })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /10-30 09:39/ })).toBeTruthy()
    await ui.unmount()
  }
})
