import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import type { Snapshot, Task } from '../types'
import { activityOf, codexLimits, countTasks, frontierRows, isParked, parseFrontier, parseState, phaseSections, workerOf } from '../hooks/model.ts'
import type { OrcaWorker } from '../hooks/model.ts'

/** 테스트 본문이 받는 `on`(엔진 자리에 훅을 거는 함수). 키트가 이 타입을 따로 내보내지 않아 본문의 형식에서 꺼낸다. */
type On = Parameters<TestBody>[1]

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
  expect(parseState('지시 대기\n등급: light · 작업자: opencode\n막힘: 디자인 시안 확정\n')).toEqual({ phase: '지시 대기', tier: 'light', worker: 'opencode', blocker: '디자인 시안 확정' })
  expect(parseState('구현 중\r\n막힘:  API 키 발급  \r\n')).toEqual({ phase: '구현 중', blocker: 'API 키 발급' })
  expect(parseState('구현 중\n\n막힘:\n')).toEqual({ phase: '구현 중' })
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
  // 관리자가 막힘을 적어 두면 기다리는 줄 아는 것이라 멈춤이 아니다.
  expect(isParked(task('a', '구현 중', 'none', { blocker: '사용자 결정' }), NOW)).toBe(false)
})

test('codex_limit.py의 창 길이로 이름을 붙인다', () => {
  const json = { status: 'ok', windows: [{ used_percent: 6, window_minutes: 10080, resets_at: '2026-10-30 09:39' }] }
  expect(codexLimits(json)).toEqual([{ name: 'Codex 7d', percent: 6, resets: '10-30 09:39' }])
  expect(codexLimits({ status: 'unknown' })).toEqual([])
})

test('개수를 단계와 활동별로 센다', () => {
  const counts = countTasks([task('a', '구현 중', 'working'), task('b', '검토 중', 'waiting'), task('c', '지시 대기', 'idle', { blocker: '결정' })], NOW)
  expect(counts).toEqual({ 구현: 1, 검토: 1, 수정: 0, waiting: 1, parked: 0, blocked: 1, user: 1 })
})

test('패널의 칸은 단계 순서대로, 빈 단계와 끝난 작업은 빼고, 모르는 단계는 뒤에', () => {
  const tasks = [
    task('a', '검토 중', 'working'), task('b', 'PR 열림', 'idle'), task('c', '구현 중', 'working'),
    task('d', '구현 중', 'waiting'), task('e', '끝', 'idle'), task('f', '보류', 'idle'),
  ]
  expect(phaseSections(tasks, NOW).map(section => [section.phase, section.tasks.map(item => item.name)])).toEqual([
    ['구현 중', ['d', 'c']], ['검토 중', ['a']], ['PR 열림', ['b']], ['보류', ['f']],
  ])
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
  props: { title: '지휘 현황', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
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

test('패널은 지휘 현황(진행·완료 수) 아래 단계마다 칸을 나눠 작업을 날짜와 함께 보여 준다', async ($, on) => {
  seed(on, { isManager: true, snapshot: { ...SNAP, tasks: [...SNAP.tasks, task('issue-14', '구현 중', 'working')] } })
  const day = `${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}/${String(new Date(NOW).getDate()).padStart(2, '0')}`
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /지휘 현황  진행 4 · 완료 1/})).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^구현 중 2$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^검토 중 1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^지시 대기 1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^완료 1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^수정 중/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /issue-12  codex@high/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /issue-13  claude  입력 기다림/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✓ issue-8/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: day })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /10-30 09:39/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('frontier.json은 배열이나 issues로 받고, 이름·상태가 없거나 모르는 상태인 줄은 버린다', () => {
  const issues = [
    { name: 'issue-21', title: '로그인', status: 'ready' },
    { name: 'issue-22', status: 'waiting', needs: ['issue-21', 3] },
    { name: 'issue-23', status: 'blocked', blocker: '디자인 확정' },
    { name: '', status: 'ready' }, { name: 'issue-24', status: 'later' }, 'issue-25',
  ]
  const parsed = [
    { name: 'issue-21', status: 'ready', title: '로그인' },
    { name: 'issue-22', status: 'waiting', needs: ['issue-21'] },
    { name: 'issue-23', status: 'blocked', blocker: '디자인 확정' },
  ]
  expect(parseFrontier({ issues })).toEqual(parsed)
  expect(parseFrontier(issues)).toEqual(parsed)
  expect(parseFrontier({ nope: true })).toEqual([])
})

test('맡길 이슈 칸은 작업 폴더가 있는 이슈를 빼고, 맡길 수 있음·기다림·막힘 순서로 적힌 차례를 지킨다', () => {
  const frontier = parseFrontier([
    { name: 'issue-23', status: 'blocked' }, { name: 'issue-22', status: 'waiting' },
    { name: 'issue-30', status: 'ready' }, { name: 'issue-12', status: 'ready' }, { name: 'issue-21', status: 'ready' },
  ])
  expect(frontierRows(frontier, [task('issue-12', '구현 중', 'working')]).map(issue => issue.name))
    .toEqual(['issue-30', 'issue-21', 'issue-22', 'issue-23'])
})

const FRONTIER: Snapshot = {
  ...SNAP,
  tasks: [...SNAP.tasks, task('issue-10', 'PR 열림', 'idle')],
  frontier: parseFrontier([
    { name: 'issue-21', title: '로그인', status: 'ready' }, { name: 'issue-22', status: 'waiting', needs: ['issue-21'] },
    { name: 'issue-23', status: 'blocked', blocker: '디자인 확정' }, { name: 'issue-12', status: 'ready' },
  ]),
  frontierAt: NOW - 3 * MINUTE,
}

/** 버튼이 보낸 지시를 모은다(엔진 자리의 prompt.submit 훅) */
function capturePrompts(on: On): string[] {
  const sent: string[] = []
  on('prompt.submit', (_, e) => (sent.push(e.text), { text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  return sent
}

test('패널은 맡길 이슈를 ●·○·■로 보여 주고, 진행 중인 이슈는 다시 싣지 않는다', async ($, on) => {
  seed(on, { isManager: true, snapshot: FRONTIER })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^맡길 이슈 3  3분 전 기준$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /● issue-21  로그인/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /○ issue-22  ← issue-21/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /■ issue-23  막힘: 디자인 확정/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^● issue-12$/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('지시 대기의 PR 올려와 맡길 이슈의 맡기기는 사용자가 칠 지시를 그대로 보낸다', async ($, on) => {
  seed(on, { isManager: true, snapshot: FRONTIER })
  const sent = capturePrompts(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pr-issue-9' })
  await ui.press({ key: 'assign-issue-21' })
  expect(sent).toEqual(['issue-9 PR 올려', 'issue-21 맡겨'])
  await ui.unmount()
})

test('보낸 지시는 작업 단계가 바뀔 때까지 다시 누를 수 없다', async ($, on) => {
  // 보낸 기록은 모듈 변수라 다른 테스트와 겹치지 않는 이슈로 본다.
  const snap = { ...FRONTIER, frontier: [...FRONTIER.frontier!, { name: 'issue-31', status: 'ready' as const }] }
  seed(on, { isManager: true, snapshot: snap })
  const sent = capturePrompts(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'assign-issue-31' })).toBeTruthy()
  await ui.press({ key: 'assign-issue-31' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Button', key: 'assign-issue-31' })).toBeFalsy()
  expect(sent).toEqual(['issue-31 맡겨'])
  await again.unmount()
})

test('병합은 두 번 눌러야 보낸다', async ($, on) => {
  seed(on, { isManager: true, snapshot: FRONTIER })
  const sent = capturePrompts(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'merge-issue-10' })
  expect(sent).toEqual([])
  await ui.press({ key: 'merge-issue-10' })
  expect(sent).toEqual(['issue-10 병합해'])
  await ui.unmount()
})

test('막힌 작업은 띠와 패널에 ■ 막힘과 이유로 나오고, 멈춤으로 세지 않는다', async ($, on) => {
  const blocked = task('issue-15', '구현 중', 'none', { worker: 'codex@high', blocker: 'API 키 발급' })
  seed(on, { isManager: true, snapshot: { ...SNAP, tasks: [blocked] } })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /■ issue-15 막힘/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /멈춤/ })).toBeFalsy()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /■ issue-15  codex@high  막힘: API 키 발급/ })).toBeTruthy()
  await pane.unmount()
})

test('완료가 둘 이상이면 한 줄로 접고, 펼치기로 한 줄씩 본다', async ($, on) => {
  seed(on, { isManager: true, snapshot: { ...SNAP, tasks: [task('issue-8', '끝', 'idle'), task('issue-7', '끝', 'idle', { phaseSince: NOW - 20 * MINUTE })] } })
  on('ui.invalidate', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^완료 2$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✓ issue-8, issue-7/ })).toBeTruthy()
  await ui.press({ key: 'done-toggle' })
  await ui.unmount()
  const open = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await open.find({ type: 'Text', text: /^✓ issue-7$/ })).toBeTruthy()
  expect(await open.find({ type: 'Button', key: 'done-toggle' })).toBeTruthy()
  // 펼친 상태는 모듈 변수라 다른 테스트를 위해 되돌린다.
  await open.press({ key: 'done-toggle' })
  await open.unmount()
})
