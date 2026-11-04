# OpenCode Go

OpenCode Go는 빠르고 범위가 분명한 일을 맡는다. 어느 일에 쓰는지는 [tiers.md](tiers.md)의 등급별 목록이 정하고, 이 파일은 OpenCode에만 붙는 조건과 방법을 적는다. 결과는 언제나 다른 계열이 검증한다. 누가 검증할지는 등급의 검토 목록이 정한다([tiers.md](tiers.md) "검토자 고르기").

## 맡기지 않는 일

다음 중 하나라도 해당하면 등급 목록에 있어도 OpenCode를 건너뛴다.

- UI 작업이다(프로젝트 설정의 "UI 작업").
- 프로젝트 설정의 "간단한 구현에서 뺄 영역"을 건드린다.
- 실창 검사가 필요하다.
- 설계를 새로 정해야 한다(새 도메인 개념, 공용 인터페이스, 여러 방안 중 고르기).
- 무엇을 어디에 할지 명세에 구체적으로 적을 수 없다.

명세에 경고·금지 문구가 많다는 것만으로는 설계가 필요한 일로 보지 않는다.

**크기 상한**: `standard`는 프로젝트 설정 "등급별 배치"의 크기 상한까지만 맡긴다(없으면 파일 4개 안, 변경 200줄 안팎. 테스트 포함). 이슈 본문과 관련 파일로 미리 가늠한다.

## 모델과 강도

OpenCode 대화형 화면은 모델 옵션을 받지 않는다(Orca `worker-start`도 OpenCode에는 `--model`을 받지 않는다). 대신 OpenCode가 worktree 루트의 `opencode.json`을 읽으므로, 띄우기 전에 거기에 기본 에이전트(`build`)의 모델과 강도(`variant`)를 적는다. 모델과 강도를 둘 다 정하지 않았으면 이 절을 건너뛰고 기본값으로 띄운다.

1. worktree가 아직 없으면 먼저 만든다(실행 환경 문서의 "worktree 만들기"). 저장소에 이미 커밋된 `opencode.json`이 있으면 이 방법을 쓰지 않고 기본값으로 띄운 뒤 사용자에게 알린다.
2. worktree 루트에 쓴다. `model`은 `opencode models`가 보여 주는 `provider/model` 이름이고, 모델을 정하지 않았으면 `~/.config/opencode/opencode.json`의 기본 모델을 적는다.

   ```json
   { "agent": { "build": { "model": "opencode-go/deepseek-v4.1-flash", "variant": "high" } } }
   ```
3. 이 파일이 커밋되지 않게 메인 저장소의 `.git/info/exclude`에 `/opencode.json`을 더한다(worktree가 함께 쓰는 파일이라 한 번이면 된다).
4. worktree에서 `opencode debug agents`를 돌려 `build`의 `model`에 정한 모델과 `variant`가 보이는지 확인한다.
5. 실행 환경 문서의 "띄우기"대로 그 worktree에 띄운다.

같은 worktree에서 다음 OpenCode 작업자의 강도가 다르면 파일을 고치고 4번을 다시 한다. 실제로 쓰인 값은 `~/.local/share/opencode/opencode.db`의 `session_v2.model`에서 확인할 수 있다.

`opencode run`(아래 빠른 답변)에서는 `-m provider/model#variant`로 준다.

**`opencode run` 공통 주의**(OpenCode 2.2.5에서 확인)
- 표준 입력을 `< /dev/null`로 닫는다. 표준 입력이 터미널이 아니고 열려 있으면(셸 도구가 그렇게 넘기는 경우가 있다) 입력이 끝나기를 기다리며 세션도 만들지 않고 멈춘다.
- 시간 제한으로 끊어도 세션은 취소되지 않는다. 다음에 서비스(`opencode serve --service`)가 뜰 때 끊긴 세션을 이어서 끝까지 돌려 사용량을 쓴다. 그래서 시간 제한은 넉넉히(10분 이상) 둔다.
- 전역 기본 강도는 `~/.config/opencode/opencode.json`에서 에이전트마다 `model`과 `variant`를 **함께** 적어 준다(`{"agent": {"plan": {"model": "opencode-go/deepseek-v4.1-flash", "variant": "high"}}}`). `model` 없이 `variant`만 적으면 "unsupported legacy model variant"로 버려지고, 최상위 `model`의 `#variant`나 객체의 `variant`는 실행에 적용되지 않았다. `plan`이 띄우는 `explore`·`general` 하위 에이전트도 각자 적는다. 적용 여부는 `opencode debug agents`의 `model.variant`와 `opencode.db` `session_message`의 `"variant"`로 확인한다.

## 검증

- 검토자는 등급의 검토 목록에서 고른다([tiers.md](tiers.md) "검토자 고르기"). `관리자`를 고르면 [tiers.md](tiers.md)의 "관리자 확인"을 한다.
- 지적 수정은 [fixes.md](fixes.md)의 재검토 규칙을 따른다.

## rebase

SKILL.md 6단계 2의 rebase는 `light`다.

- 명세에 rebase 전 `HEAD`를 적어 둔다.
- import, 목록 순서, 붙어 있는 줄처럼 양쪽 의도를 모두 살리기 쉬운 충돌은 OpenCode가 해결한다.
- 같은 함수의 동작이 양쪽에서 바뀐 충돌이면 `git rebase --abort`로 되돌리고 보고하게 한다. 관리자는 그 rebase를 원래 구현 작업자에게 맡긴다.
- 검증: 관리자가 `git -C <worktree> range-diff <옛 base>..<검토 통과 SHA> origin/main..<PR head>`로 확인하고, 관련 테스트 통과를 확인한다. `<옛 base>`는 `git -C <worktree> merge-base <검토 통과 SHA> origin/main`이다. rebase 뒤 작업자가 `git push --force-with-lease`로 PR을 갱신한 다음 PR head를 조회한다. 모든 짝이 `=`이면 rebase만 한 것이고, `!`나 짝 없는 새 커밋(`>`) 또는 빠진 커밋(`<`)이 있으면 그 부분을 SKILL.md 6단계대로 재검토하거나 관리자가 확인한다. rebase 전 HEAD도 기록하되, 최종 비교 기준은 마지막 `검토 통과 SHA`로 한다.

## 빠른 답변·빠른 판단

관리자가 결론을 내기 전에 넓게 훑어야 하는 짧은 질문이다. 예를 들어 어느 파일이 무엇을 맡는지, 이슈가 어느 영역을 건드리는지, 지적의 심각도 첫 의견 같은 것이다.

- 메인 저장소에서 읽기 전용 `plan` 에이전트로 묻는다: `opencode run --agent plan "<질문>" < /dev/null`. 20초 안팎이 걸린다(위 "`opencode run` 공통 주의").
- 답은 관리자가 근거(파일·줄)를 직접 확인한 뒤에만 쓴다. 사용자만 정할 결정은 사용자에게 묻는다.

## 2차 의견

주 검토와 따로, 같은 diff를 `plan` 에이전트에 보여 2차 의견을 받는다. 검토 보고서의 지적과 함께 판정한다.

- **언제**: 같은 계열끼리 검토할 때는 항상([tiers.md](tiers.md) "검토자 고르기" 2). 그 밖에는 프로젝트 설정의 2차 의견 값(`standard 이상` / `모든 검토`)을 따른다. 관리자 확인과 rebase에는 받지 않는다.
- **묻는 내용**: diff 범위(`main..HEAD`), 이슈의 완료 기준, `common-findings.md`의 절대 경로를 주고, 유형별로 해당하는 결함이 있는지 파일·줄 근거와 함께 답하게 한다.
- **쓰는 법**: 2차 의견의 지적은 관리자가 근거를 직접 확인한 것만 판정에 넣는다. 주 검토 보고서와 겹치지 않는 지적이 있으면 보고서 옆에 `second-opinion-<k>.md`로 남긴다.
