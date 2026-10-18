# agent-orchestra

Claude Code 플러그인. Orca 위에서 여러 코딩 에이전트를 지휘해 GitHub 이슈를 처리한다.

- 기본 배치: Codex가 구현하고, Claude가 교차 검토한다. UI 작업은 반대로 Claude가 구현하고 Codex가 검토한다.
- OpenCode Go가 간단한 구현, 범위가 분명한 지적 수정, rebase 같은 기계적 작업, 빠른 판단을 맡는다.
- Codex·Claude의 실제 사용률을 재서 한도가 차면 배치를 바꾼다(대체 모드, Claude 절약 모드).
- 이슈 의존 관계에서 임계 경로 순서로 고르고, 교차 검토를 통과하면 병합하고 worktree를 정리한다.

## 설치

```
/plugin marketplace add vananaHope/agent-orchestra
/plugin install agent-orchestra@agent-orchestra
```

비공개 저장소이므로 `gh auth login`이나 git 자격 증명으로 접근할 수 있어야 한다.

## 필요한 것

- `gh`(로그인), `orca`, `codex`, `opencode` 명령
- Orca의 `orchestration` 스킬
- Claude 사용률 측정: [claude-hud](https://github.com/jarrodwatts/claude-hud)의 `~/.claude/plugins/claude-hud/config.json`에 `display.externalUsageWritePath`를 `~/.claude/claude-usage.json`으로 설정
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
  limits.md              한도 판정별 모드(대체 모드, Claude 절약 모드)
  opencode.md            OpenCode Go에 맡기는 일
  fixes.md               수정 작업자와 재검토
  desktop.md             실창 검사 잠금
  ui-polish.md           관리자가 직접 하는 UI 다듬기
  setup.md               프로젝트 설정 만들기
  task-template.md, review-template.md, pr-template.md
  scripts/desktop_lock.py  실창 검사 차례 잠금(~/.agent-orchestra/desktop.lock)
```

## 바꾸기

스킬을 고치면 `.claude-plugin/plugin.json`의 `version`을 올리고 커밋·push한다. 쓰는 쪽에서는 `/plugin marketplace update agent-orchestra`로 받는다.
