---
name: check-limits
description: Codex·Claude 사용 한도를 실제 사용률(창별 %·초기화 시각)로 재서 ok/warning/exhausted/unknown으로 판정한다. 한도·사용량·남은 양을 물을 때, 작업을 맡기기 전에 한도를 판단해야 할 때 사용.
---

# 한도 확인

경고 문구, 지난 세션 기록, 메모리를 근거로 한도를 말하지 않는다. 언제나 지금 잰 숫자로 말한다.

## 재기

이 스킬 폴더(`Base directory for this skill`)의 `scripts/`에 있는 스크립트를 쓴다. 기본은 둘 다 잰다. 사용자가 하나만 물었으면 그것만 잰다.

- **Codex**: `python -I <스킬 폴더>/scripts/codex_limit.py --json`
  - 짧은 `codex exec`를 한 번 돌리고, 그 실행이 남긴 세션 기록(`$CODEX_HOME/sessions/`, 없으면 `~/.codex/sessions/`)의 `rate_limits`를 읽는다. 창은 `primary`와 `secondary`이고 길이는 `window_minutes`로 본다(요금제에 따라 창이 하나뿐이거나 `primary`가 7일 창일 수 있다). 창마다 `elapsed_percent`(창이 지난 비율)도 낸다.
  - Codex를 실제로 한 번 호출하므로 사용량이 조금 들고 수십 초가 걸린다. 30분 안에 잰 결과가 이번 대화에 있으면 그것을 쓰고, 측정 시각을 함께 적는다.
- **Claude**: `python -I <스킬 폴더>/scripts/claude_limit.py --json`
  - claude-hud가 Claude Code 상태 표시줄 입력의 `rate_limits`를 `~/.claude/claude-usage.json`에 30초마다 내보낸다(`~/.claude/plugins/claude-hud/config.json`의 `display.externalUsageWritePath`. claude-hud 0.11 이상, 값은 절대경로여야 하며 `~`로 쓰면 파일이 생기지 않는다). 창은 `five_hour`와 `seven_day`다.
  - 파일을 읽기만 하므로 비용이 없다. 필요할 때마다 다시 잰다.

## 판정

스크립트가 내는 `status`를 그대로 쓴다.

| 판정 | 뜻 | 종료 코드 |
| --- | --- | --- |
| `ok` | 모든 창이 80% 미만 | 0 |
| `warning` | 한 창이라도 80% 이상 | 1 |
| `exhausted` | 한 창이라도 100%이거나 한도 도달 표시가 있음 | 2 |
| `unknown` | 확인 실패 | 2 |

`unknown`이면 추측하지 않는다. 원인을 함께 알린다.
- Claude: 스냅숏 파일이 없거나 10분 넘게 갱신되지 않았다. claude-hud 설치(0.11 이상, 상태 표시줄이 `/claude-hud:setup`의 런처로 최신 버전을 실행하는지)와 `externalUsageWritePath`가 절대경로인지 확인하라고 안내한다.
- Codex: `codex` 명령 실패, 로그인 만료, 세션 기록에 `rate_limits` 없음. 스크립트가 낸 `error` 끝부분을 보여 준다.

## 보고

에이전트마다 한 줄씩 쓴다: 판정, 창별 사용률과 초기화 시각, 측정 시각.

```
Claude ok — 5시간 26%(14:40 초기화), 7일 50%(10-22 07:00 초기화) · 10:55 측정
Codex warning — primary 83%(13:10 초기화), secondary 41%(10-23 09:00 초기화) · 10:56 측정
```

**완료 기준**: 잰 에이전트마다 판정과 창별 숫자, 초기화 시각, 측정 시각이 보고에 있다. `unknown`이면 원인이 있다.
