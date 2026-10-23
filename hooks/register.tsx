// agent-orchestra 지휘 세션의 상태 띠와 패널.
// 지휘 세션(이 세션에서 orchestrate-issues가 불림)에서만 그리고, 그때만 몇 초마다 다시 읽는다.
// 작업 단계는 `.local/orchestration/*/state.md`, 작업자 활동은 Orca가 자기 훅으로 본 값(worker-list),
// 한도는 세션이 받은 Claude 창과 check-limits의 codex_limit.py에서 온다.
//
// 모양은 ClaudeRipple의 터미널 표기를 따른다. 띠는 기호와 값을 두 칸 간격으로 늘어놓은 조용한 한 줄이고,
// 평소에는 흐리게, 볼 일이 있을 때만 노랑(입력 기다림)과 빨강(멈춤)을 쓴다. 패널은 `오늘 할 일 N` 아래
// 진행중(끝나지 않은 작업)과 완료(오늘 끝난 작업)를 `● 이름  단계 … 10/24` 한 줄씩 늘어놓는다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot, Task } from '../types'
import {
  ACTIVE_PHASES, ACTIVITY_LABEL, DONE_PHASE, USER_PHASES, ago, activityOf, bar, byUrgency, claudeLimits, codexLimits, cols,
  countTasks, isParked, isSameDay, limitGroups, monthDay, parseState, workerOf,
} from './model.ts'
import type { OrcaWorker } from './model.ts'

const PANE = 'orchestra-status'
const SKILL = 'agent-orchestra:orchestrate-issues'
const CODEX_EVERY_MS = 5 * 60 * 1000
const RUN_TIMEOUT_MS = 8000
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
const runtime: { statusBand: boolean; pollMs: number; timer?: { cancel: () => void }; isRunning: boolean; root?: string | null } = {
  statusBand: true, pollMs: 10000, isRunning: false,
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
  return { at: now, root: base, tasks, limits, ...(codexAt ? { codexAt } : {}), errors }
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

/** 보이면 닫고, 닫혀 있거나 다른 탭 뒤·좁아서 못 그린 채 열려 있으면 다시 연다. 열었으면 true */
async function togglePane($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(item => item.id === PANE)
  const wasOpen = !!pane && pane.isShown && pane.isPlaced
  if (wasOpen) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: '지휘 상태' })
  // 띠의 `패널 ●/○`이 바로 바뀌게
  $.ui.invalidate('ui.render')
  if (!wasOpen) void tick($)
  return !wasOpen
}

/** 작업자 터미널 탭으로 옮겨 간다. */
async function openWorker($: EngineInterface, terminal: string) {
  await $.process.run(['orca', 'terminal', 'switch', '--terminal', terminal, '--json'], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)
}

async function becomeManager($: EngineInterface) {
  if (!await read($, isManager)) await update($, isManager, () => true)
  startPolling($)
}

/** 작업 하나의 상태 기호·말·색: 멈춤과 사용자 차례가 Orca의 활동보다 앞선다. */
function labelOf(task: Task, now: number): { mark: string; word: string; color?: string } {
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
    await $.command.register({ name: 'orchestra-status', description: '지휘 상태 패널 열기·닫기 (on/off로 띠 켜고 끄기)', argumentHint: '[on|off]' })
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
    return { text: await togglePane($) ? '지휘 상태 패널을 열었습니다.' : '지휘 상태 패널을 닫았습니다.' }
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
    const working = open.filter(task => isActive(task) && task.activity === 'working' && !isParked(task, now)).length
    const phases = [['구현', counts.구현], ['검토', counts.검토], ['수정', counts.수정]].filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(' · ')
    // 하나뿐이면 이름으로: 무엇을 봐야 하는지 바로 안다.
    const named = (list: Task[], word: string) => list.length === 1 ? `${list[0]!.name} ${word}` : `${word} ${list.length}`
    const isStale = now - snap.at > runtime.pollMs * 3
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        <Text bold color={ACCENT}>◆ 지휘</Text>
        {waiting.length ? <Text color={WARN}>◐ {named(waiting, '입력 대기')}</Text> : null}
        {parked.length ? <Text color={BAD}>⏸ {named(parked, '멈춤')}</Text> : null}
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
    const open = byUrgency(snap.tasks.filter(task => !isDone(task)), now)
    const done = snap.tasks.filter(isDone).sort((a, b) => b.phaseSince - a.phaseSince)
    // 처음 아홉 개의 열기에 숫자 키를 그린 차례대로 준다.
    let hotkeys = 0
    const nextKey = () => (++hotkeys <= 9 ? String(hotkeys) : undefined)

    // 진행중 한 줄: `● 이름  단계 … 10/24  1: 열기`. 기호와 단계의 색이 상태다(보라 진행, 노랑 입력 대기, 빨강 멈춤).
    // 입력 대기·멈춤이면 단계 대신 그 말을 쓴다. 폭을 넘으면 이름 쪽 끝을 자른다.
    const openRow = (task: Task) => {
      const label = labelOf(task, now)
      const word = label.color === WARN || label.color === BAD ? label.word : task.phase
      const terminal = isActive(task) ? task.terminal : undefined
      const key = terminal ? nextKey() : undefined
      return (
        <Box key={'task-' + task.name} flexDirection="row" justifyContent="space-between" width="100%">
          <Text wrap="truncate-end">
            <Text color={label.color}>{label.mark} </Text>
            <Text bold>{task.name}</Text>
            <Text color={label.color} dimColor={!label.color}>{'  ' + word}</Text>
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>{monthDay(task.phaseSince)}</Text>
            {terminal ? <Button key={'open-' + task.name} plain {...(key ? { hotkey: key } : {})} dimColor label="열기" onPress={() => openWorker($, terminal)} /> : null}
          </Box>
        </Box>
      )
    }

    const doneRow = (task: Task) => (
      <Box key={'done-' + task.name} flexDirection="row" justifyContent="space-between" width="100%">
        <Text wrap="truncate-end"><Text color={GOOD}>✓ </Text>{task.name}</Text>
        <Text dimColor>{monthDay(task.phaseSince)}</Text>
      </Box>
    )

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

    return (
      <Box flexDirection="column" width="100%">
        <Text bold>오늘 할 일 <Text color={ACCENT}>{open.length + done.length}</Text></Text>
        <Text> </Text>
        <Text bold color={ACCENT}>진행중</Text>
        {rule}
        {open.length ? open.map(openRow) : <Text dimColor>없음</Text>}
        <Text> </Text>
        <Text bold color={GOOD}>완료</Text>
        {rule}
        {done.length ? done.map(doneRow) : <Text dimColor>없음</Text>}
        <Text> </Text>
        {rule}
        <Text bold>한도</Text>
        {groups.length ? null : <Text dimColor>아직 잰 값이 없습니다</Text>}
        {groups.flatMap(group => group.windows.map((limit, index) => limitLine(group.name, limit, index === 0)))}
        {snap.errors.length ? rule : null}
        {snap.errors.map(error => <Text color={WARN} wrap="wrap">? {error}</Text>)}
        {rule}
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
