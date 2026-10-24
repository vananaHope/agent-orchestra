// agent-orchestra 지휘 세션의 상태 띠와 패널.
// 지휘 세션(이 세션에서 orchestrate-issues가 불림)에서만 그리고, 그때만 몇 초마다 다시 읽는다.
// 작업 단계는 `.local/orchestration/*/state.md`, 맡길 이슈는 관리자가 쓰는 `.local/orchestration/frontier.json`,
// 작업자 활동은 Orca가 자기 훅으로 본 값(worker-list), 한도는 세션이 받은 Claude 창과 check-limits의 codex_limit.py에서 온다.
//
// 모양은 ClaudeRipple의 터미널 표기를 따른다. 띠는 기호와 값을 두 칸 간격으로 늘어놓은 조용한 한 줄이고,
// 평소에는 흐리게, 볼 일이 있을 때만 노랑(입력 기다림)과 빨강(멈춤)을 쓴다. 패널은 `지휘 현황  진행 N · 완료 N` 아래
// 단계마다(구현 중 … PR 열림, 맡길 이슈, 오늘 끝난 것은 완료) 칸을 나눠 `● 이름  작업자 … 10/24` 한 줄씩 늘어놓는다.
// 지시 대기·PR 열림·맡길 이슈 줄의 버튼은 사용자가 치는 지시(`issue-9 PR 올려`)를 지휘 세션에 그대로 보낸다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FrontierIssue, Limit, Snapshot, Task } from '../types'
import {
  ACTIVE_PHASES, ACTIVITY_LABEL, DONE_PHASE, USER_PHASES, ago, activityOf, bar, claudeLimits, codexLimits, cols,
  countTasks, frontierRows, isParked, isSameDay, limitGroups, monthDay, parseFrontier, parseState, phaseSections, workerOf,
} from './model.ts'
import type { OrcaWorker } from './model.ts'

const PANE = 'orchestra-status'
const PANE_TITLE = '지휘 현황'
const SKILL = 'agent-orchestra:orchestrate-issues'
const CODEX_EVERY_MS = 5 * 60 * 1000
const RUN_TIMEOUT_MS = 8000
/** 병합은 이 안에 한 번 더 눌러야 보낸다 */
const ARM_MS = 5 * 1000
/** 보낸 지시는 지휘 세션이 처리해 단계가 바뀔 때까지 `보냄`으로 둔다. 처리되지 않으면 이만큼 지난 뒤 다시 누를 수 있다. */
const SENT_MS = 10 * 60 * 1000
/** 이 플러그인의 check-limits 스크립트 */
const CODEX_SCRIPT = 'skills/check-limits/scripts/codex_limit.py'
/** 강조색: 테마를 따르는 연보라(ClaudeRipple의 강조색과 같은 계열) */
const ACCENT = 'suggestion'
const WARN = 'warning'
const BAD = 'error'
const GOOD = 'success'

const isManager = atom({ plugin: 'agent-orchestra', key: 'isManager' } as const, false)
const isBandOff = atom({ plugin: 'agent-orchestra', key: 'isBandOff' } as const, false)
const snapshot = atom({ plugin: 'agent-orchestra', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })

type Options = { statusBand?: boolean; pollSeconds?: number }

/** 모듈 변수: 다시 불러오면 처음부터 시작한다(register가 다시 채운다). */
const runtime: {
  statusBand: boolean; pollMs: number; timer?: { cancel: () => void }; isRunning: boolean; root?: string | null
  /** 한 번 눌러 둔 병합: 그 작업과 기한 */
  armed?: { name: string; until: number }
  /** 보낸 지시(버튼 key): 보낸 시각과 그때의 표시(작업의 phaseSince, 맡길 이슈면 frontierAt) */
  sent: Map<string, { at: number; mark: number | undefined }>
  /** 완료 칸을 펼쳤다(기본은 한 줄로 접음) */
  isDoneOpen: boolean
} = {
  statusBand: true, pollMs: 10000, isRunning: false, sent: new Map(), isDoneOpen: false,
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160)
}

function isActive(task: { phase: string }): boolean {
  return (ACTIVE_PHASES as readonly string[]).includes(task.phase)
}

function isDone(task: { phase: string }): boolean {
  return task.phase === DONE_PHASE
}

function limitColor(percent: number): string | undefined {
  return percent >= 100 ? BAD : percent >= 80 ? WARN : undefined
}

/** 저장소의 메인 폴더: worktree에서 열린 세션이라도 작업 파일은 메인 저장소에 있다. */
async function repoRoot($: EngineInterface): Promise<string | null> {
  if (runtime.root !== undefined) return runtime.root
  const cwd = await $.session.cwd()
  const result = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: RUN_TIMEOUT_MS })
    .catch(() => undefined)
  const common = result?.exitCode === 0 ? result.stdout.trim().replace(/\\/g, '/') : ''
  runtime.root = common ? common.replace(/\/\.git\/?$/, '') : null
  return runtime.root
}

async function orcaJson($: EngineInterface, argv: string[]): Promise<Record<string, unknown>> {
  const result = await $.process.run(['orca', ...argv, '--json'], { timeoutMs: RUN_TIMEOUT_MS })
  const parsed = JSON.parse(result.stdout) as { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string } }
  if (!parsed.ok || !parsed.result) throw new Error(`orca ${argv.slice(0, 2).join(' ')}: ${parsed.error?.message ?? result.stderr.trim() ?? 'failed'}`)
  return parsed.result
}

/** 끝나지 않은 작업 전부와 오늘 끝난 작업 */
async function readTasks($: EngineInterface, base: string, now: number): Promise<Omit<Task, 'activity'>[]> {
  const dir = `${base}/.local/orchestration`
  if (!await $.fs.exists(dir)) return []
  const tasks: Omit<Task, 'activity'>[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'dir') continue
    const file = `${dir}/${entry.name}/state.md`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (!stat) continue
    const state = parseState(await $.fs.read(file))
    if (!state.phase || (state.phase === DONE_PHASE && !isSameDay(stat.mtimeMs, now))) continue
    tasks.push({ name: entry.name, ...state, phaseSince: stat.mtimeMs })
  }
  return tasks
}

/** 관리자가 쓴 맡길 이슈 목록. 파일이 없으면 undefined(칸을 그리지 않는다). */
async function readFrontier($: EngineInterface, base: string): Promise<{ issues: FrontierIssue[]; at: number } | undefined> {
  const file = `${base}/.local/orchestration/frontier.json`
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (!stat) return undefined
  return { issues: parseFrontier(JSON.parse((await $.fs.read(file)).replace(/^﻿/, ''))), at: stat.mtimeMs }
}

async function codexLimit($: EngineInterface): Promise<Limit[] | undefined> {
  const path = `${$.plugin.root}/${CODEX_SCRIPT}`
  if (!await $.fs.exists(path)) return undefined
  const result = await $.process.run(['python', '-I', path, '--json'], { timeoutMs: 30000 })
  return codexLimits(JSON.parse(result.stdout))
}

async function collect($: EngineInterface, previous: Snapshot | null): Promise<Snapshot> {
  const now = await $.clock.now()
  const errors: string[] = []
  const base = await repoRoot($).catch(error => (errors.push(errorText(error)), null))
  const found = base ? await readTasks($, base, now).catch(error => (errors.push(errorText(error)), [])) : []
  const frontier = base ? await readFrontier($, base).catch(error => (errors.push(`frontier.json: ${errorText(error)}`), undefined)) : undefined

  let workers: OrcaWorker[] = []
  const outputs = new Map<string, number>()
  if (found.some(isActive)) {
    try {
      const list = await orcaJson($, ['orchestration', 'worker-list', '--limit', '100'])
      workers = (list.workers as OrcaWorker[] | undefined) ?? []
      const terminals = await orcaJson($, ['terminal', 'list'])
      for (const terminal of (terminals.terminals as { handle?: string; lastOutputAt?: number }[] | undefined) ?? []) {
        if (terminal.handle && typeof terminal.lastOutputAt === 'number') outputs.set(terminal.handle, terminal.lastOutputAt)
      }
    } catch (error) { errors.push(errorText(error)) }
  }
  const tasks: Task[] = found.map(task => {
    const worker = isActive(task) ? workerOf(task.name, workers) : undefined
    const terminal = worker?.agentTerminalHandle
    const lastOutputAt = terminal ? outputs.get(terminal) : undefined
    const agent = worker?.projection?.provider?.id ?? undefined
    return {
      ...task,
      // Orca를 못 읽었으면 작업자가 없다고 하지 않는다.
      activity: !isActive(task) ? 'idle' : errors.length && !workers.length ? 'unknown' : activityOf(worker),
      ...(agent ? { agent } : {}),
      ...(terminal ? { terminal } : {}),
      ...(lastOutputAt ? { lastOutputAt } : {}),
    }
  })

  const usage = await $.session.usage().catch(() => undefined)
  let codexAt = previous?.codexAt
  let codex = previous?.limits.filter(limit => limit.name.startsWith('Codex')) ?? []
  if (!codexAt || now - codexAt > CODEX_EVERY_MS) {
    try {
      const measured = await codexLimit($)
      if (measured) { codex = measured; codexAt = now }
    } catch (error) { errors.push(`Codex 한도: ${errorText(error)}`) }
  }
  const limits = [...codex, ...claudeLimits(usage?.rateLimits ?? [])]
  return {
    at: now, root: base, tasks, limits, ...(codexAt ? { codexAt } : {}),
    ...(frontier ? { frontier: frontier.issues, frontierAt: frontier.at } : {}), errors,
  }
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

/** 열려 있고 지금 화면에 그려져 있다(띠의 `패널 ●`) */
async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

/** 띠가 보이거나 패널이 열려 있을 때만 다시 읽는다. */
async function tick($: EngineInterface) {
  if (runtime.isRunning || !await read($, isManager)) return
  const isBandShown = runtime.statusBand && !await read($, isBandOff)
  if (!isBandShown && !await isPaneOpen($)) return
  runtime.isRunning = true
  try {
    const next = await collect($, await read($, snapshot))
    await update($, snapshot, () => next)
  } catch (error) {
    $.ui.log(`orchestra-status: ${errorText(error)}`, { to: 'debug' })
  } finally {
    runtime.isRunning = false
  }
}

function startPolling($: EngineInterface) {
  if (runtime.timer) return
  runtime.timer = $.clock.every(runtime.pollMs, () => { void tick($) })
  void tick($)
}

/**
 * 보이면 닫고, 닫혀 있거나 다른 탭 뒤·좁아서 못 그린 채 열려 있으면 다시 연다. 열었으면 true.
 * 열 때 키를 달라고 한다(`focus`): 프롬프트가 비어 있으면 패널이 키를 받아 Tab·화살표로 버튼을 고르고, Esc로 프롬프트에 돌아간다.
 */
async function togglePane($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(item => item.id === PANE)
  const wasOpen = !!pane && pane.isShown && pane.isPlaced
  if (wasOpen) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
  // 띠의 `패널 ●/○`이 바로 바뀌게
  $.ui.invalidate('ui.render')
  if (!wasOpen) void tick($)
  return !wasOpen
}

/** 작업자 터미널 탭으로 옮겨 간다. */
async function openWorker($: EngineInterface, terminal: string) {
  await $.process.run(['orca', 'terminal', 'switch', '--terminal', terminal, '--json'], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)
}

/** 사용자가 칠 지시를 그대로 지휘 세션에 보낸다. 지휘 세션이 일하는 중이면 그 턴이 끝난 뒤 들어간다. */
async function sendDirective($: EngineInterface, key: string, text: string, mark: number | undefined) {
  runtime.sent.set(key, { at: await $.clock.now(), mark })
  $.ui.invalidate('ui.render')
  const result = await $.prompt.submit({ text, asUser: true }).catch((error: unknown) => ({ drop: errorText(error) }))
  if (result.drop !== undefined) {
    runtime.sent.delete(key)
    $.ui.invalidate('ui.render')
    $.ui.toast(`지시를 보내지 못했습니다: ${result.drop}`)
    return
  }
  $.ui.toast(`지휘 세션에 보냄: ${text}`)
}

/** 병합은 되돌리기 어려워 두 번 눌러야 보낸다: 첫 번째는 `한 번 더: 병합`으로 바꾸기만 한다. */
async function pressMerge($: EngineInterface, task: Task) {
  const { name } = task
  const now = await $.clock.now()
  if (runtime.armed?.name === name && now < runtime.armed.until) {
    runtime.armed = undefined
    await sendDirective($, 'merge-' + name, `${name} 병합해`, task.phaseSince)
    return
  }
  runtime.armed = { name, until: now + ARM_MS }
  $.ui.invalidate('ui.render')
}

async function becomeManager($: EngineInterface) {
  if (!await read($, isManager)) await update($, isManager, () => true)
  startPolling($)
}

/** 작업 하나의 상태 기호·말·색: 관리자가 적은 막힘, 멈춤, 사용자 차례가 Orca의 활동보다 앞선다. */
function labelOf(task: Task, now: number): { mark: string; word: string; color?: string } {
  if (task.blocker) return { mark: '■', word: '막힘: ' + task.blocker, color: BAD }
  if (isParked(task, now)) return { mark: '⏸', word: '멈춤', color: BAD }
  if (!isActive(task)) return { mark: '◇', word: '사용자 지시 기다림', color: ACCENT }
  const label = ACTIVITY_LABEL[task.activity]
  return { ...label, color: task.activity === 'working' ? ACCENT : task.activity === 'waiting' ? WARN : undefined }
}

export const register: Register = (on, options) => {
  const { statusBand = true, pollSeconds = 10 } = (options ?? {}) as Options
  runtime.statusBand = statusBand !== false
  runtime.pollMs = Math.max(3, Number(pollSeconds) || 10) * 1000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'orchestra-status', description: '지휘 현황 패널 열기·닫기 (on/off로 띠 켜고 끄기)', argumentHint: '[on|off]' })
    if (await read($, isManager)) startPolling($)
    return started
  })

  // 표시는 덤이다: 여기서 실패해도 사용자의 프롬프트와 도구 호출은 그대로 간다.
  on('prompt.submit', async ($, e, next) => {
    if (e.command?.name === SKILL) await becomeManager($).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const skill = (e as { skill?: unknown }).skill
    if (e.tool === 'Skill' && skill === SKILL) await becomeManager($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'orchestra-status' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await update($, isBandOff, () => true)
      return { text: '지휘 상태 띠를 껐습니다. `/orchestra-status on`으로 다시 켭니다.' }
    }
    await update($, isBandOff, () => false)
    await becomeManager($)
    if (arg === 'on') return { text: '지휘 상태 띠를 켰습니다.' }
    return { text: await togglePane($) ? '지휘 현황 패널을 열었습니다.' : '지휘 현황 패널을 닫았습니다.' }
  })

  // 사람이 패널의 닫기 표시나 Esc로 닫아도 띠의 `패널 ●/○`이 따라오게
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) $.ui.invalidate('ui.render')
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!runtime.statusBand || e.props.hasSurvey || !await read($, isManager) || await read($, isBandOff)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const paneShown = await isPaneShown($)
    // 단축키는 띠가 키를 쥘 때만 눌린다(ctrl+x tab이나 클릭). 프롬프트에서 친 p는 글자로 들어간다.
    const control = (
      <Box key="pane-control" flexDirection="row" columnGap={1}>
        <Button key="pane" plain hotkey="p" label={`패널 ${paneShown ? '●' : '○'}`} onPress={() => togglePane($)} />
        <Text dimColor>ctrl+x tab</Text>
      </Box>
    )
    if (!snap) {
      return (
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Text bold color={ACCENT}>◆ 지휘</Text>
          <Text dimColor>불러오는 중…</Text>
          {control}
        </Box>
      )
    }
    const now = await $.clock.now()
    const open = snap.tasks.filter(task => !isDone(task))
    const counts = countTasks(open, now)
    const waiting = open.filter(task => task.activity === 'waiting')
    const parked = open.filter(task => isParked(task, now))
    const blocked = open.filter(task => task.blocker)
    const working = open.filter(task => isActive(task) && task.activity === 'working' && !isParked(task, now) && !task.blocker).length
    const phases = [['구현', counts.구현], ['검토', counts.검토], ['수정', counts.수정]].filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(' · ')
    // 하나뿐이면 이름으로: 무엇을 봐야 하는지 바로 안다.
    const named = (list: Task[], word: string) => list.length === 1 ? `${list[0]!.name} ${word}` : `${word} ${list.length}`
    const isStale = now - snap.at > runtime.pollMs * 3
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        <Text bold color={ACCENT}>◆ 지휘</Text>
        {waiting.length ? <Text color={WARN}>◐ {named(waiting, '입력 대기')}</Text> : null}
        {parked.length ? <Text color={BAD}>⏸ {named(parked, '멈춤')}</Text> : null}
        {blocked.length ? <Text color={BAD}>■ {named(blocked, '막힘')}</Text> : null}
        {working ? <Text color={ACCENT}>● 일하는 중 {working}</Text> : null}
        {phases ? <Text dimColor>{phases}</Text> : null}
        {counts.user ? <Text color={ACCENT}>◇ 지시 대기 {counts.user}</Text> : null}
        {!open.length ? <Text dimColor>○ 진행 중인 작업 없음</Text> : null}
        {snap.limits.length ? <Text dimColor>│</Text> : null}
        {limitGroups(snap.limits).map(group => (
          <Text>
            <Text dimColor>{group.name}</Text>
            {group.windows.map(limit => (
              <Text color={limitColor(limit.percent)} dimColor={!limitColor(limit.percent)}> {limit.span} {Math.round(limit.percent)}%</Text>
            ))}
          </Text>
        ))}
        {isStale || snap.errors.length ? <Text color={WARN}>? {isStale ? '갱신 멈춤' : '일부 못 읽음'}</Text> : null}
        {control}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    const snap = await read($, snapshot)
    if (!snap) return <Text dimColor wrap="wrap">지휘를 시작하면 여기에 작업이 나옵니다.</Text>
    const now = await $.clock.now()
    const sections = phaseSections(snap.tasks, now)
    const openCount = sections.reduce((sum, section) => sum + section.tasks.length, 0)
    const done = snap.tasks.filter(isDone).sort((a, b) => b.phaseSince - a.phaseSince)
    const frontier = frontierRows(snap.frontier ?? [], snap.tasks)
    // 처음 아홉 개의 열기에 숫자 키를 그린 차례대로 준다.
    let hotkeys = 0
    const nextKey = () => (++hotkeys <= 9 ? String(hotkeys) : undefined)

    // 지시 버튼: 보냈고 그 뒤로 작업 단계(맡길 이슈면 목록)가 그대로면 버튼 대신 `보냄`.
    // 단축키는 없다(패널이 키를 쥐면 Tab·화살표로 고르고 Enter).
    const isSent = (key: string, mark: number | undefined) => {
      const sent = runtime.sent.get(key)
      return !!sent && sent.mark === mark && now - sent.at < SENT_MS
    }
    const directive = (key: string, mark: number | undefined, label: string, onPress: () => unknown) =>
      isSent(key, mark) ? <Text dimColor>보냄</Text> : <Button key={key} plain label={label} onPress={onPress} />
    const directiveOf = (task: Task) => {
      if (task.phase === '지시 대기') {
        return directive('pr-' + task.name, task.phaseSince, 'PR 올려', () => sendDirective($, 'pr-' + task.name, `${task.name} PR 올려`, task.phaseSince))
      }
      if (task.phase !== 'PR 열림') return null
      const isArmed = runtime.armed?.name === task.name && now < runtime.armed.until
      return directive('merge-' + task.name, task.phaseSince, isArmed ? '한 번 더: 병합' : '병합해', () => pressMerge($, task))
    }

    // 작업 한 줄: `● 이름  codex@high  입력 기다림 … 10/24  1: 열기`. 칸이 단계라 단계는 다시 쓰지 않는다.
    // 기호의 색이 활동이다(보라 일하는 중, 노랑 입력 대기, 빨강 멈춤). 폭을 넘으면 이름 쪽 끝을 자른다.
    const openRow = (task: Task) => {
      const label = labelOf(task, now)
      const alert = label.color === WARN || label.color === BAD ? label.word : undefined
      const terminal = isActive(task) ? task.terminal : undefined
      const key = terminal ? nextKey() : undefined
      return (
        <Box key={'task-' + task.name} flexDirection="row" justifyContent="space-between" width="100%">
          <Text wrap="truncate-end">
            <Text color={label.color}>{label.mark} </Text>
            <Text bold>{task.name}</Text>
            {task.worker ? <Text dimColor>{'  ' + task.worker}</Text> : null}
            {alert ? <Text color={label.color}>{'  ' + alert}</Text> : null}
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>{monthDay(task.phaseSince)}</Text>
            {directiveOf(task)}
            {terminal ? <Button key={'open-' + task.name} plain {...(key ? { hotkey: key } : {})} dimColor label="열기" onPress={() => openWorker($, terminal)} /> : null}
          </Box>
        </Box>
      )
    }

    // 맡길 이슈 한 줄: `● issue-21  제목  … 맡기기`, `○ issue-22  ← issue-21`, `■ issue-23  막힘: 이유`
    const frontierRow = (issue: FrontierIssue) => (
      <Box key={'frontier-' + issue.name} flexDirection="row" justifyContent="space-between" width="100%">
        <Text wrap="truncate-end">
          {issue.status === 'ready' ? <Text color={GOOD}>● </Text> : issue.status === 'waiting' ? <Text dimColor>○ </Text> : <Text color={BAD}>■ </Text>}
          <Text bold={issue.status === 'ready'} dimColor={issue.status === 'waiting'}>{issue.name}</Text>
          {issue.title ? <Text dimColor>{'  ' + issue.title}</Text> : null}
          {issue.status === 'waiting' && issue.needs ? <Text dimColor>{'  ← ' + issue.needs.join(', ')}</Text> : null}
          {issue.status === 'blocked' ? <Text color={BAD}>{'  막힘' + (issue.blocker ? ': ' + issue.blocker : '')}</Text> : null}
        </Text>
        {issue.status === 'ready'
          ? directive('assign-' + issue.name, snap.frontierAt, '맡기기', () => sendDirective($, 'assign-' + issue.name, `${issue.name} 맡겨`, snap.frontierAt))
          : null}
      </Box>
    )

    const doneRow = (task: Task) => (
      <Box key={'done-' + task.name} flexDirection="row" justifyContent="space-between" width="100%">
        <Text wrap="truncate-end"><Text color={GOOD}>✓ </Text>{task.name}</Text>
        <Text dimColor>{monthDay(task.phaseSince)}</Text>
      </Box>
    )
    const toggleDone = () => {
      runtime.isDoneOpen = !runtime.isDoneOpen
      $.ui.invalidate('ui.render')
    }
    // 완료는 남은 일이 위에 보이게 한 줄로 접는다: `✓ issue-8, issue-7 …  펼치기`. 하나뿐이면 그대로 한 줄.
    const doneRows = done.length < 2 ? done.map(doneRow) : runtime.isDoneOpen
      ? [...done.map(doneRow), <Box key="done-fold" flexDirection="row" justifyContent="flex-end" width="100%">
          <Button key="done-toggle" plain hotkey="d" dimColor label="접기" onPress={toggleDone} />
        </Box>]
      : [<Box key="done-fold" flexDirection="row" justifyContent="space-between" width="100%">
          <Text wrap="truncate-end"><Text color={GOOD}>✓ </Text><Text dimColor>{done.map(task => task.name).join(', ')}</Text></Text>
          <Button key="done-toggle" plain hotkey="d" dimColor label="펼치기" onPress={toggleDone} />
        </Box>]

    // 한도 한 줄: `Codex  7d ██░░░░░░  7%`. 이름은 묶음의 첫 줄에만, 초기화는 넉넉할 때 끝에 붙인다.
    const groups = limitGroups(snap.limits)
    const nameCells = Math.max(0, ...groups.map(group => cols(group.name)))
    const fixed = nameCells + 1 + 2 + 1 + 1 + 4
    const meter = Math.max(4, Math.min(12, width - fixed - 12))
    const resetRoom = width - fixed - meter >= 13
    const limitLine = (name: string, limit: Limit & { span: string }, first: boolean) => (
      <Text key={'limit-' + limit.name} wrap="truncate-end">
        <Text dimColor={!first}>{(first ? name : '') + ' '.repeat(nameCells - (first ? cols(name) : 0))}</Text>
        <Text dimColor> {limit.span} </Text>
        <Text color={limitColor(limit.percent) ?? ACCENT}>{bar(limit.percent, meter)}</Text>
        <Text color={limitColor(limit.percent)}>{String(Math.round(limit.percent)).padStart(4)}%</Text>
        {resetRoom && limit.resets ? <Text dimColor>  {limit.resets}</Text> : null}
      </Text>
    )

    // 칸 하나: 제목과 개수(덧붙일 말), 줄, 작업들. 작업자가 붙는 단계는 보라, 사용자 차례는 기본색, 완료는 초록.
    const section = (title: string, color: string | undefined, rows: JSX.Element[], note?: string, count = rows.length) => [
      <Text key={'gap-' + title}> </Text>,
      <Text key={'title-' + title} bold color={color}>{title} <Text dimColor>{count}{note ? '  ' + note : ''}</Text></Text>,
      <Text key={'rule-' + title} dimColor>{'─'.repeat(width)}</Text>,
      ...rows,
    ]

    return (
      <Box flexDirection="column" width="100%">
        <Text bold>지휘 현황  <Text dimColor>진행</Text> <Text color={ACCENT}>{openCount}</Text><Text dimColor> · 완료</Text> <Text color={GOOD}>{done.length}</Text></Text>
        {sections.flatMap(({ phase, tasks }) => section(phase, isActive({ phase }) ? ACCENT : undefined, tasks.map(openRow)))}
        {frontier.length ? section('맡길 이슈', undefined, frontier.map(frontierRow), snap.frontierAt ? `${ago(now - snap.frontierAt)} 전 기준` : undefined) : null}
        {done.length ? section('완료', GOOD, doneRows, undefined, done.length) : null}
        {!openCount && !done.length && !frontier.length ? <Text dimColor>지휘 중인 작업이 없습니다</Text> : null}
        <Text> </Text>
        {rule}
        <Text bold>한도</Text>
        {groups.length ? null : <Text dimColor>아직 잰 값이 없습니다</Text>}
        {groups.flatMap(group => group.windows.map((limit, index) => limitLine(group.name, limit, index === 0)))}
        {snap.errors.length ? rule : null}
        {snap.errors.map(error => <Text color={WARN} wrap="wrap">? {error}</Text>)}
        {rule}
        {e.props.isFocused ? <Text dimColor wrap="truncate-end">Tab·화살표 고르기  Enter 누르기  Esc 프롬프트로</Text> : null}
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text dimColor>{ago(now - snap.at)} 전</Text>
          <Box flexDirection="row" columnGap={2}>
            <Button key="refresh" plain hotkey="r" dimColor label="새로 고침" onPress={() => tick($)} />
            <Button key="close" plain hotkey="p" dimColor label="닫기" onPress={() => togglePane($)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
