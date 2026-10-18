# 프로젝트 설정 만들기

메인 저장소에 `docs/agents/orchestration.md`가 없을 때 한 번 한다. 끝나면 SKILL.md로 돌아가 1단계부터 진행한다.

## 1. 전제 확인

다음이 갖춰졌는지 확인하고, 빠진 것은 사용자에게 알린다. 지휘는 갖춰진 뒤에 시작한다.

- GitHub 저장소이고 `gh`가 로그인돼 있다. 이슈에 `ready-for-agent` 라벨을 쓴다(없으면 `docs/agents/triage-labels.md` 또는 라벨 준비를 사용자와 정한다).
- `orca`, `codex`, `opencode` 명령이 있다.
- `check-limits` 스킬로 잰 Codex와 Claude가 둘 다 `unknown`이 아니다. `unknown`이면 그 스킬이 알려 주는 원인을 사용자에게 전한다.
- `.gitignore`에 `.local/`이 있다. 없으면 더한다.

## 2. 설정 초안 쓰기

저장소를 먼저 훑는다: `README`, `AGENTS.md`/`CLAUDE.md`, `CONTEXT.md`, `docs/`, `docs/adr/`, 패키지·빌드 설정, 테스트 폴더, CI 설정. 찾을 수 있는 것은 찾아서 채우고, 저장소로 알 수 없는 것만 사용자에게 묻는다(예: 무엇을 UI로 볼지, 병합 전에 사용자 승인이 필요한 이슈).

아래 양식으로 `docs/agents/orchestration.md`를 쓴다. 절 이름은 SKILL.md와 양식들이 그대로 가리키므로 바꾸지 않는다. 해당 없는 선택 절은 지운다. 각 절은 명세에 그대로 옮겨질 문장으로 쓴다.

```markdown
# 이슈 지휘 설정

`orchestrate-issues` 스킬이 읽는 이 프로젝트의 설정이다.

## 스펙과 먼저 읽을 문서

<전체 스펙 이슈(예: `gh issue view 1`, 특히 볼 절), 작업 전 반드시 읽을 문서 목록과 각 문서가 무엇인지>

## 구현 제약

<기술 스택(ADR), 아키텍처 규칙(어디에 도메인 규칙을 두는지 등), 용어 규칙, 테스트 작성 원칙>

## 환경 준비

<새 worktree에서 의존성을 준비하는 명령>

## 테스트

<관련 테스트만 돌리는 명령과 예시. 병렬 실행 옵션이 있으면 함께. 전체 테스트 명령(관리자가 Release 직전에 돌림)>

## UI 작업

<이 프로젝트에서 Claude가 구현할 UI 작업의 범위: 폴더, 화면, 대화상자, 문구 등>

## 간단한 구현에서 뺄 영역

<OpenCode Go에 맡기지 않을 위험한 영역: 공용 계약, DB 버전, 플랫폼별 코드 등>

## 추가 완료 조건

<특정 종류의 이슈에 붙는 완료 조건. 예: 프런트엔드 변경은 lint·typecheck·build 통과, 기본 창 크기 스크린샷, 데이터 개수별 배치 확인. 어느 이슈에 붙는지 함께 적는다.>

## 실창 검사 (선택)

<앱이 실제 창을 띄우는 경우만. 데스크톱 없이 스크린샷 찍는 방법, 실창이 꼭 필요한 검사 목록>

## 확인 자료 (선택)

<사람·검토자가 실제 동작을 재현할 때 쓸 자료의 위치와 내용>

## 병합 예외 (선택)

<교차 검토 통과 뒤에도 사용자 승인을 받고 병합할 이슈나 조건>
```

`docs/agents/common-findings.md`도 만든다. 처음에는 제목과 다음 문단만 둔다: "교차 검토 보고서(`.local/orchestration/issue-*/review*.md`)에서 반복해 나온 지적을 유형별로 모은다. 구현자는 제출 전에 이 목록으로 스스로 점검하고, 검토자는 이 목록을 먼저 확인한다. 새 유형이 두 번 이상 나오면 관리자가 여기에 더한다. 유형마다 예시(이슈 번호)와 '점검' 한 줄을 둔다."

## 3. 연결하기

`AGENTS.md`(없으면 `CLAUDE.md`)에 다음 한 줄을 더한다.

```markdown
### Issue orchestration

Settings for the `orchestrate-issues` skill (agent-orchestra plugin). See `docs/agents/orchestration.md` and `docs/agents/common-findings.md`.
```

**완료 기준**: 두 파일이 있고, 사용자가 설정 초안을 확인했다. 커밋은 사용자가 원할 때 한다.
