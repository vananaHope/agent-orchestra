# agent-orchestra

Claude Code 플러그인. Orca 위에서 여러 코딩 에이전트를 지휘해 GitHub 이슈를 처리한다.

- 기본 배치: Codex가 구현하고, Claude가 교차 검토한다. UI 작업은 반대로 Claude가 구현하고 Codex가 검토한다.
- OpenCode Go가 간단한 구현과 빠른 판단을 맡는다.
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

이슈 구현이나 다음 묶음 진행을 요청하면 `agent-orchestra:orchestrate-issues` 스킬이 불린다. 스킬은 프로젝트마다 다음 두 파일을 읽는다.

| 파일 | 내용 |
| --- | --- |
| `docs/agents/orchestration.md` | 스펙 위치, 구현 제약, 환경 준비·테스트 명령, UI 범위, 추가 완료 조건, 실창 검사 등 |
| `docs/agents/common-findings.md` | 그 프로젝트의 교차 검토에서 반복된 지적 목록 |

처음 쓰는 프로젝트에서는 두 파일이 없으므로 스킬이 저장소를 훑고 몇 가지를 물어 만든다(`skills/orchestrate-issues/setup.md`). 작업 파일은 각 저장소의 `.local/orchestration/`에 쌓인다.

## 구성

```
.claude-plugin/          플러그인·마켓플레이스 정의
skills/orchestrate-issues/
  SKILL.md               지휘 흐름과 고정 규칙
  setup.md               프로젝트 설정 만들기
  task-template.md       구현 명세 양식
  review-template.md     교차 검토 명세 양식
  pr-template.md         PR 본문 양식
  scripts/
    codex_limit.py       Codex 사용률 측정
    claude_limit.py      Claude 사용률 측정
    desktop_lock.py      실창 검사 차례 잠금(~/.agent-orchestra/desktop.lock)
```

## 바꾸기

스킬을 고치면 `.claude-plugin/plugin.json`의 `version`을 올리고 커밋·push한다. 쓰는 쪽에서는 `/plugin marketplace update agent-orchestra`로 받는다.
