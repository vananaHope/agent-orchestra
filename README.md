# agent-orchestra

Claude Code 플러그인. Orca 위에서 여러 코딩 에이전트를 지휘해 GitHub 이슈를 처리한다.

- 등급별 배치: 일마다 등급(light/standard/hard/max)을 정하고, 등급별 구현 목록과 검토 목록(OpenCode·Codex·Claude·관리자, 모델·추론 강도 포함)에서 작업자와 검토자를 고른다. 목록은 설정 창에서 정한다. 검토자는 구현자와 다른 계열이고, UI 작업은 Claude가 구현한다(검토 기본값은 Codex). OpenCode `plan`의 2차 의견을 언제 받을지도 정할 수 있다.
- OpenCode Go가 light·standard의 앞자리(범위가 분명한 구현·지적 수정·rebase)와 빠른 판단을 맡는다.
- Codex·Claude의 실제 사용률을 재서 한도가 차면 배치를 바꾼다(대체 모드, Claude 절약 모드).
- 이슈 의존 관계에서 임계 경로 순서로 고르고, 교차 검토를 통과하면 병합하고 worktree를 정리한다.

## 설치

```
/plugin marketplace add vananaHope/agent-orchestra
/plugin install agent-orchestra@agent-orchestra
```

## 필요한 것

- `gh`(로그인), `orca`, `codex`, `opencode` 명령
- Orca의 `orchestration` 스킬
- Claude 사용률 측정: [claude-hud](https://github.com/jarrodwatts/claude-hud)의 `~/.claude/plugins/claude-hud/config.json`에 `display.externalUsageWritePath`를 `~/.claude/claude-usage.json`의 절대경로(예: `C:/Users/<사용자>/.claude/claude-usage.json`)로 설정. claude-hud 0.11 이상이 필요하고, `~`로 쓰면 파일이 생기지 않는다
- Python 3.10 이상(보조 스크립트)

## 프로젝트에서 쓰기

| 스킬 | 불리는 때 |
| --- | --- |
| `agent-orchestra:orchestrate-issues` | 이슈 구현, 다음 이슈·다음 묶음 진행을 요청할 때 |
| `agent-orchestra:check-limits` | Codex·Claude 한도를 물을 때(지휘 중에도 쓰임) |
| `/agent-orchestra:configure` | 직접 칠 때만. 프로젝트 설정을 설정 창으로 만들거나 고침 |

처음 쓰는 프로젝트에서는 지휘를 시작할 때 설정 창이 뜬다. 저장소를 훑어 찾은 값이 추천 선택지로 들어 있어서 대부분 고르기만 하면 된다.

프로젝트마다 고를 수 있는 것:

- **이슈 저장소**: GitHub 이슈, 로컬 md(형식은 프로젝트마다 지정), 아티팩트(데이터베이스로 상태까지 기록)
- **병합 방식**: `자동`(관리자가 PR·병합까지) 또는 `지시`(검토를 통과하면 멈추고 "PR 올려"·"병합해"·"병합됐어"·"리뷰 반영해" 지시를 기다림). 기본 브랜치와 병합 방법(merge/squash/rebase)도 지정
- **작성 규칙**: 메시지 언어, PR 서명 줄
- **설정 위치**: 저장소에 커밋(`docs/agents/orchestration.md`)하거나, 로컬에만(`.local/orchestration/settings.md`, `.git/info/exclude`로 제외)

설정이 없던 기존 프로젝트는 GitHub 이슈의 `ready-for-agent` 라벨, GitHub 이슈 의존 관계, 본문 체크리스트, `자동` 병합(`merge`)을 기본값으로 쓴다. 작업 파일은 각 저장소의 `.local/orchestration/`에 쌓인다.

## 클라우드에서 쓰기

Claude Code 클라우드 세션(claude.ai/code, 모바일 앱)에서는 Orca 없이 돈다. 세션이 `CLAUDE_CODE_REMOTE=true`면 지휘 스킬이 `runner-cloud.md`를 읽어 worktree는 `git worktree`로, Claude 작업자는 서브에이전트로, Codex·OpenCode는 `codex exec`·`opencode run`으로 띄운다. 등급별 배치, 교차 검토, 병합 규칙은 같다.

로컬과 다른 점:

- Claude 한도는 재지 않는다(상태 표시줄이 없어 claude-hud를 못 씀). 서브에이전트가 한도 에러로 끝나면 Claude 절약 모드로 간다.
- GitHub GraphQL이 막혀 있어 `gh issue`·`gh pr`은 `gh api` REST로 바꿔 쓴다.
- 실창 검사는 하지 않고 사람이 확인할 항목으로 넘긴다.

### 클라우드 환경 설정

claude.ai/code에서 개인 클라우드 환경을 하나 만든다(세션 제목 줄의 환경 메뉴 → 추가). 환경 변수는 그 환경을 쓰는 사람이 모두 볼 수 있으니 공유 환경에 넣지 않는다.

1. **Network access**: Custom으로 두고 기본 목록을 포함한 채 Allowed domains에 더한다. `chatgpt.com`, `auth.openai.com`, `api.openai.com`(Codex), `opencode.ai`, `models.dev`(OpenCode). 쓰는 OpenCode 모델 제공자의 호스트도 더한다. 막히면 에러에 나온 호스트를 더한다.
2. **Setup script**: `npm install -g @openai/codex opencode-ai`. 결과가 캐시되므로 세션마다 다시 설치하지 않는다.
3. **Codex 구독 로그인**: PC에서 클라우드 전용 로그인을 따로 만든다. 평소 `~/.codex` 로그인은 건드리지 않는다. 갱신 토큰이 한 번 쓰면 바뀌므로 PC의 `auth.json`을 그대로 복사하면 PC 쪽이 로그아웃될 수 있다.

   ```powershell
   # PowerShell
   mkdir "$env:USERPROFILE\.codex-cloud" -Force
   $env:CODEX_HOME = "$env:USERPROFILE\.codex-cloud"
   codex login
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.codex-cloud\auth.json")) | Set-Clipboard
   ```

   클립보드 값을 환경 변수 `CODEX_AUTH_JSON_B64`로 넣는다. 지휘를 시작할 때 `~/.codex/auth.json`으로 풀어 쓴다.
   - 클라우드 세션이 토큰을 갱신하면 환경 변수의 값은 낡는다. 지휘가 "Codex 클라우드 로그인 갱신 필요"라고 알리면 위 명령을 다시 돌려 값을 바꾼다. 클라우드 지휘 세션을 동시에 여러 개 돌리면 더 빨리 낡는다.
4. **OpenCode 로그인**(쓰는 경우): 같은 방식으로 PC의 `~/.local/share/opencode/auth.json`(Windows는 OpenCode 데이터 폴더의 같은 파일)을 base64로 `OPENCODE_AUTH_JSON_B64`에 넣는다.

### 플러그인 설치

클라우드 세션은 PC에 설치한 플러그인을 쓰지 못하고, 저장소 `.claude/settings.json`의 `enabledPlugins`·`extraKnownMarketplaces`도 설치하지 않는다(공식 문서 "What carries over from your setup"). 클라우드 환경의 Setup script에서 CLI로 설치한다. 결과는 환경 캐시에 들어가므로 세션마다 다시 받지 않는다.

```bash
claude plugin marketplace add vananaHope/agent-orchestra
claude plugin install agent-orchestra@agent-orchestra
```

- 캐시는 Setup script나 허용 도메인을 바꿀 때, 그리고 약 7일마다 다시 만들어진다. 그때 최신 버전을 받는다. 바로 받고 싶으면 Setup script에 주석 한 줄을 바꿔 캐시를 다시 만들게 한다.
- 다른 브랜치를 받으려면 `vananaHope/agent-orchestra#<브랜치>`처럼 `#`을 붙인다.

## 구성

```
.claude-plugin/          플러그인·마켓플레이스 정의
skills/check-limits/     Codex·Claude 실제 사용률 측정(따로 불러도 됨)
  SKILL.md
  scripts/codex_limit.py, claude_limit.py
skills/configure/        설정 창으로 프로젝트 설정 만들기·고치기(사용자만 부름)
skills/orchestrate-issues/
  SKILL.md               역할, 배치, 시작 조건, 1~7단계
  trackers.md            이슈 저장소별 동작(GitHub, 로컬 md, 아티팩트)
  limits.md              한도 판정별 모드(대체 모드, Claude 절약 모드, 클라우드)
  runner-cloud.md        클라우드 세션 실행(Orca 대신 git worktree·서브에이전트·codex exec·opencode run, GitHub REST)
  tiers.md               등급 기준, 등급별 구현·검토 목록, 검토자 고르기, 관리자 확인, 맡김 기록
  opencode.md            OpenCode Go 조건, 모델·강도 주기, rebase
  codex-fast.md          Codex fast를 켤지 정하는 기준과 worktree에 주는 방법
  fixes.md               수정 작업자와 재검토
  desktop.md             실창 검사 잠금
  ui-polish.md           관리자가 직접 하는 UI 다듬기
  setup.md               프로젝트 설정 만들기
  task-template.md, review-template.md, pr-template.md
  scripts/desktop_lock.py  실창 검사 차례 잠금(~/.agent-orchestra/desktop.lock), install로 고정 경로 ~/.agent-orchestra/bin/에 복사
  scripts/check_tiers.py   등급별 배치 표기의 모델·강도를 도구 목록과 대조
```

## 바꾸기

스킬을 고치면 `.claude-plugin/plugin.json`의 `version`을 올리고 커밋·push한다. 쓰는 쪽에서는 `/plugin marketplace update agent-orchestra`로 받는다.
