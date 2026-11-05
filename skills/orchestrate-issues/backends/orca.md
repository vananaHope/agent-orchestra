# 실행 환경: Orca

SKILL.md의 동작([SKILL.md](../SKILL.md) "실행 환경")을 Orca에서 하는 방법이다. Orca 명령의 정확한 인자는 이 문서에 없다. Orca 명령을 처음 쓰기 전에 `orchestration` 스킬을 불러 그 안내대로 `orca skills get orchestration`을 읽는다(버전에 맞는 안내가 그쪽에 있다).

## 준비

이번 지휘 세션 전체에 Run 하나를 만든다. 이미 있으면 그것을 쓴다. 아래의 `<run>`이 그 Run이다.

## worktree 만들기

`orca worktree create --name <작업 이름>-<slug> --repo path:<메인 저장소> --base-branch main --setup run --json`. 결과의 worktree id를 `state.md`에 적어 둔다. 작업자를 새 worktree로 바로 띄울 때는 이 단계 없이 `worker-start`가 만든다(아래 "띄우기"). OpenCode에 모델·강도를 주거나 Codex fast를 정할 때는 설정 파일을 먼저 써야 하므로 이 단계로 먼저 만든다.

## 띄우기

- **새 worktree**: `worker-start --spec "<명세>" --worktree new-top-level --name <작업 이름>-<slug> --base-branch main --agent <에이전트>`.
- **기존 worktree**(검토자, 지적 수정, rebase, 미리 만든 worktree): `--worktree "id:<worktree id>"`.
- **남겨 둔 터미널에 다시 맡기기**: `--terminal <handle>`. 이때는 `--model`·`--effort`를 함께 쓸 수 없다(처음 띄운 강도를 그대로 쓴다).

에이전트별 모델·강도:

- **Claude·Codex**: `--model <모델> --effort <강도>`. 강도만 정했으면 모델은 그 에이전트 설정의 기본 모델을 적는다(`--effort`는 `--model`이 있어야 한다). 둘 다 없으면 두 옵션을 뺀다.
- **Codex fast**: `worker-start`에는 Codex 설정을 넘길 옵션이 없다. 아래 "Codex fast"대로 worktree의 Codex 설정으로 준다.
- **OpenCode**: `worker-start`가 OpenCode에는 `--model`을 받지 않는다. 모델이나 강도를 정했으면 아래 "OpenCode 모델과 강도"대로 준다. 둘 다 없으면 `--agent opencode`만 쓴다.

### OpenCode 모델과 강도

[opencode.md](../opencode.md)의 "모델과 강도"대로 worktree에 `opencode.json`을 쓴 뒤 `worker-start --spec ... --worktree "id:<worktree id>" --agent opencode`로 띄운다.

### Codex fast

Codex는 작업 폴더의 `.codex/config.toml`을 전역 설정보다 우선해 읽으므로 거기에 쓴다. 이 파일은 신뢰된 경로에서만 읽힌다(`$CODEX_HOME/config.toml`의 `[projects.'<경로>'] trust_level = "trusted"`. 상위 경로를 신뢰해도 된다).

1. worktree가 아직 없으면 먼저 만든다(위 "worktree 만들기"). 저장소에 이미 커밋된 `.codex/config.toml`이 있으면 쓰지 않고 전역 설정대로 띄운 뒤 사용자에게 알린다.
2. `<worktree>/.codex/config.toml`에 켜면 `service_tier = "fast"`, 끄면 `service_tier = "default"`를 쓴다. 끌 때도 파일을 지우지 않고 적는 것은 전역 설정이 fast일 수 있기 때문이다. 같은 worktree에 다음 Codex 작업자를 띄울 때마다 다시 정해 고친다.
3. 이 파일이 커밋되지 않게 메인 저장소의 `.git/info/exclude`에 `/.codex/`를 더한다(worktree가 함께 쓰는 파일이라 한 번이면 된다).
4. 위 "띄우기"대로 띄운다.

`.codex/config.toml`이 없거나 `state.md`에 fast 기록이 없으면 이 단계를 빠뜨린 것이다. 띄우는 절차를 스크립트나 반복문으로 만들어 쓰고 있으면 거기에도 이 단계를 넣는다.

## 제출 확인

`orca orchestration worker-read --dispatch <id> --source terminal --json`으로 작업자 화면을 읽는다. `draft`에 `[Pasted Content ...]`나 명세 일부가 남아 있으면 붙여넣기만 되고 제출되지 않은 것이다. 이때는 같은 명세를 다시 보내지 말고 `orca terminal send --terminal <handle> --enter`로 Enter만 보낸다.

- 특히 기존 터미널을 재사용할 때(`--terminal`) 잘 생긴다.
- `orca terminal read`의 결과에는 draft가 나오지 않으니 이 확인에 쓰지 않는다.

작업자 화면에 "Working"이 보이면 제출된 것이다.

## 기다리기

`check --run <run> --wait --types "worker_done,escalation,question"`을 백그라운드로 돌려 **깨어나는 신호로만** 쓴다. 그 출력은 파일로 받든 grep을 거치든 한국어가 깨진다. 깨어나면 내용은 `check --run <run> --json | PYTHONIOENCODING=utf-8 python -I -c "..."`처럼 python으로 바로 넘겨 다시 읽는다. ack하기 전까지는 같은 묶음이 다시 나온다.

- `heartbeat`: ack하고 계속 기다린다.
- `question`: SKILL.md 3단계의 "질문"이다. 답은 아래 "답하기".
- `worker_done`: SKILL.md 3단계의 "완료 보고"다.
- `escalation`: 작업자가 막혔다. 화면을 읽고 질문처럼 다룬다.

메시지를 처리하기 전에는 ack하지 않는다.

## 답하기

답은 반드시 `orca orchestration reply --run <run> --id <질문 msg_id> --body "..."`로 보낸다. `send --to dispatch:...`로 보내면 작업자의 `ask`는 답을 받지 못하고 시간 초과된다.

## 보내기

남겨 둔 작업자에게 다음 지시(지적 수정, 재검토, `main` 변경 안내)를 보낼 때는 위 "띄우기"의 `--terminal <handle>`로 새 명세를 맡긴다. 보낸 뒤 "제출 확인"을 한다.

## 남겨 두기

끝난 작업자를 `worker-retain`으로 남긴다. 터미널이 닫히지 않아 같은 작업자에게 다시 맡길 수 있다.

## 정리

`worker-release`로 작업자들을 정리한다. 재사용한 터미널은 `retained`(`user_takeover` 등)로 남을 수 있다. `worker-list --run <run> --terminal-state reclaimable`이 0이면 정리가 끝난 것이다.

## worktree 지우기

`orca worktree rm --worktree path:<worktree 경로>`. 병합된 로컬 브랜치도 함께 지워진다. 지우기 전에 그 worktree를 쓰는 작업자 터미널이 남아 있으면 먼저 닫는다.

## 작업자가 보고하는 방법

명세 양식의 `{실행 환경: 완료 보고}`와 `{실행 환경: 질문}`에 넣는 문장이다.

- 완료 보고(구현자): "완료 보고는 `worker_done` 요약으로 한다."
- 완료 보고(검토자): "보고서 파일 경로를 `--report-path`로 넘긴다. `worker_done` 요약은 3문장 이내로 결론만."
- 질문: "질문은 orchestration `ask`로 한다."
