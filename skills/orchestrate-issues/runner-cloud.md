# 클라우드 실행

Claude Code 클라우드 세션(`CLAUDE_CODE_REMOTE=true`)에서 지휘할 때 쓴다. 클라우드에는 Orca가 없으므로 이 문서가 Orca 명령을 대신한다. 등급, 배치, 교차 검토, 판정, 병합 규칙과 `state.md`·맡김 기록은 SKILL.md와 다른 문서를 그대로 따르고, **작업자를 띄우고 기다리고 정리하는 방법**과 **GitHub 명령**만 이 문서로 바꾼다.

| 로컬(Orca) | 클라우드 |
| --- | --- |
| Run | 없음. 이 지휘 세션 자체가 Run이다 |
| `worker-start --worktree new-top-level` | `git worktree add`(아래 "worktree") |
| Claude 작업자 | Agent 도구로 띄운 서브에이전트 |
| Codex·OpenCode 작업자 | 백그라운드 Bash로 돌리는 `codex exec`·`opencode run` |
| `check --wait`(worker_done) | 백그라운드 작업이 끝나면 오는 알림 |
| `ask`/`reply` | 작업자가 `question-<k>.md`를 쓰고 멈춤 → 관리자가 같은 세션을 이어서 답함 |
| `worker-retain`, `--terminal <handle>` | 같은 세션 이어 가기(아래 "이어 가기") |
| `worker-release`, `orca worktree rm` | 할 일 없음 / `git worktree remove` |
| `gh issue …`, `gh pr …` | `gh api` REST(아래 "GitHub") |

## 시작할 때

1. **얕은 클론 풀기**: 클라우드 저장소는 얕게, `main`만 받아 온다. 그대로면 새 브랜치의 upstream이 잡히지 않아 "push하지 않은 커밋" 확인이 틀리고, `merge-base` 확인도 실패한다.

   ```bash
   git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
   git fetch --depth=1000 origin
   ```
2. **도구 확인**: `codex --version`, `opencode --version`. 없는 도구는 그 계열을 등급 목록에서 건너뛴다고 사용자에게 한 줄로 알린다. 설치는 클라우드 환경의 Setup script가 맡는다(README "클라우드에서 쓰기").
3. **로그인 복원**: 환경 변수 `CODEX_AUTH_JSON_B64`, `OPENCODE_AUTH_EXPORT_B64`가 있고 이 세션에서 아직 복원하지 않았을 때만 복원한다. 이미 복원했으면(쉬었다 다시 연 세션) 다시 하지 않는다. 세션 안에서 갱신된 최신 토큰을 낡은 값으로 덮어쓰지 않기 위해서다. 값은 출력하지 않는다.

   ```bash
   f="${CODEX_HOME:-$HOME/.codex}/auth.json"
   [ -n "${CODEX_AUTH_JSON_B64:-}" ] && [ ! -s "$f" ] && mkdir -p "$(dirname "$f")" \
     && printf '%s' "$CODEX_AUTH_JSON_B64" | base64 -d > "$f" && chmod 600 "$f"
   # OpenCode v2는 로그인을 파일이 아니라 자체 저장소에 둔다. `auth export`로 뽑은 JSON을 `auth import`로 넣는다.
   m="$HOME/.local/state/agent-orchestra/opencode-imported"
   [ -n "${OPENCODE_AUTH_EXPORT_B64:-}" ] && [ ! -f "$m" ] \
     && printf '%s' "$OPENCODE_AUTH_EXPORT_B64" | base64 -d | opencode auth import \
     && mkdir -p "$(dirname "$m")" && touch "$m"
   ```
   복원한 뒤 `opencode auth list`에 OpenCode Go가 보이는지 확인한다. 안 보이면 OpenCode를 등급 목록에서 건너뛴다고 알린다.
4. **Codex 로그인 확인**: `codex login status`가 ChatGPT 로그인이 아니거나 `check-limits`의 Codex가 `unknown`이면 "Codex 클라우드 로그인 갱신 필요"라고 알리고 Codex를 한도 `exhausted`처럼 다룬다([limits.md](limits.md) 대체 모드). 갱신 방법은 README의 "클라우드에서 쓰기"에 있다.
5. **작업 폴더**: worktree는 메인 저장소 옆 `<메인 저장소>/../worktrees/`에 둔다. 작업 파일은 로컬과 같이 메인 저장소의 `.local/orchestration/`이다. `.local/`이 `.git/info/exclude`에 없으면 더한다.

## worktree

```bash
git -C <메인 저장소> fetch origin main
git -C <메인 저장소> worktree add -b <작업 이름>-<slug> <메인 저장소>/../worktrees/<작업 이름>-<slug> origin/main
```

- 프로젝트 설정의 "환경 준비" 명령은 worktree를 만든 뒤 관리자가 먼저 돌린다(Orca의 setup에 해당). 시간이 걸리면 백그라운드로 돌리고 끝난 뒤 작업자를 띄운다.
- 구현자, 검토자, 지적 수정, rebase 작업자는 같은 worktree를 쓴다.

## 띄우기

명세(`task.md`, `review-<k>.md` 등)는 로컬과 똑같이 Write 도구로 쓴다. 띄울 때 바꾸는 것은 다음 세 가지다.

- **질문**: 명세의 마지막 줄 "orchestration `ask`로 질문"을 다음으로 바꾼다: "막히거나 스펙이 모호하면 추측하지 말고 `<작업 폴더 절대 경로>/question-<k>.md`에 질문을 쓰고, 지금까지 한 일을 커밋한 뒤 멈춘다. 마지막 응답 첫 줄에 `질문 있음`이라고 쓴다."
- **결과 보고**: "`worker_done` 요약"과 "`--report-path`로 넘긴다"는 "마지막 응답"과 "그 파일에 쓴다"로 읽게 한다.
- **이슈 읽기**: 클라우드에서는 작업자도 `gh issue view`를 쓸 수 없다(GraphQL 차단). GitHub 이슈여도 로컬 md처럼 이슈 본문과 댓글을 명세의 "이슈 본문"에 옮긴다([trackers.md](trackers.md) 공통).

에이전트별 띄우는 방법:

### Claude

Agent 도구로 띄운다. `isolation`은 쓰지 않는다(구현자와 검토자가 같은 worktree를 써야 하므로).

- `prompt`: "작업 폴더는 `<worktree 절대 경로>`다. 모든 명령은 그 폴더에서 돌리고, 그 밖의 파일은 건드리지 않는다." 다음 줄부터 명세 전문.
- `model`: 표기의 모델(`claude:opus@high`면 `opus`). 없으면 뺀다.
- `effort`: 표기의 강도. 이 스킬이 정한 값이므로 Agent 도구의 `effort`로 넘긴다. 없으면 뺀다.
- `run_in_background`: true. 끝나면 알림이 온다(worker_done).
- 돌려받은 에이전트 ID를 `state.md`에 `Claude 세션: <ID>`로 적는다.

Claude 작업자는 이 세션의 구독 한도를 같이 쓴다. 따로 인증할 것이 없다.

### Codex

백그라운드 Bash(`run_in_background: true`, 넉넉한 `timeout`)로 돌린다.

```bash
codex exec -C <worktree> \
  -m <모델> -c model_reasoning_effort="<강도>" -c service_tier="<fast|default>" \
  --dangerously-bypass-approvals-and-sandbox \
  -o <작업 폴더>/codex-last-<k>.md \
  "$(cat <명세 절대 경로>)" > <작업 폴더>/codex-<k>.log 2>&1
```

- 모델·강도를 정하지 않았으면 그 옵션을 뺀다.
- `service_tier`는 [codex-fast.md](codex-fast.md)의 판단대로 **띄울 때마다** 넣는다. 껐어도 `default`로 적는다. 로컬과 달리 `.codex/config.toml`과 신뢰 설정은 쓰지 않는다.
- 샌드박스를 끄는 것은 클라우드 VM이 이미 격리돼 있고, Codex 샌드박스가 worktree 밖의 `<메인 저장소>/.git/worktrees/`에 쓰는 `git commit`을 막기 때문이다. **로컬에서는 이 옵션을 쓰지 않는다.**
- 끝나면 `codex-last-<k>.md`가 마지막 응답이다.
- 세션 ID: `$CODEX_HOME/sessions/`(없으면 `~/.codex/sessions/`)에서 `cwd`가 그 worktree인 가장 새 기록의 첫 줄(`session_meta`)의 `id`. `state.md`에 `Codex 세션: <ID>`로 적는다. 같은 기록의 `service_tier`로 fast가 실제로 적용됐는지도 본다([codex-fast.md](codex-fast.md) 적용 5).

### OpenCode

OpenCode v2(`@opencode/cli`) 기준이다. v2의 `run`에는 `--dir`·`--variant`가 없다. 폴더는 실행 위치로, 강도는 모델 뒤 `#<강도>`로 준다.

```bash
cd <worktree> && opencode run --standalone -m <provider/model>#<강도> --auto --format json \
  "$(cat <명세 절대 경로>)" > <작업 폴더>/opencode-<k>.jsonl 2>&1
```

- 백그라운드 Bash로 돌린다. 모델·강도를 정하지 않았으면 `-m`을 빼고, 모델만 정했으면 `#<강도>`를 뺀다. 로컬처럼 `opencode.json`을 쓰지 않는다.
- `--standalone`은 작업자마다 따로 서버를 띄운다. 빼면 공용 백그라운드 서비스에 붙는데, 여러 worktree의 작업자가 동시에 돌 때 섞이지 않게 쓴다.
- `--auto`가 없으면 권한 요청에서 멈춘다.
- 이벤트의 세션 ID를 `state.md`에 `OpenCode 세션: <ID>`로 적는다. 마지막 응답은 마지막 텍스트 이벤트다.
- 빠른 답변·2차 의견(`opencode run --agent plan`)은 로컬과 같다. 메인 저장소나 worktree로 `cd`한 뒤 돌린다.

## 기다리기

- 작업자마다 백그라운드 작업 하나다. 끝나면 알림이 오므로 따로 폴링하지 않는다. 기다리는 동안 다른 작업을 띄우거나 1단계(프런티어)를 다시 볼 수 있다.
- 알림이 오면 먼저 `question-<k>.md`가 생겼는지 본다.
  - **있으면** question 처리(SKILL.md 3단계)와 같다. 답은 아래 "이어 가기"로 같은 세션에 보낸다.
  - **없으면** worker_done이다. 마지막 응답과 커밋(`git -C <worktree> log --oneline main..HEAD`)을 보고 4단계로 간다.
- 작업자가 실패로 끝났으면(종료 코드, 로그 끝부분) 원인을 보고 같은 세션을 이어 가거나, [tiers.md](tiers.md) "고르기"대로 다음 작업자로 넘긴다. 한도나 로그인 에러면 [limits.md](limits.md)의 클라우드 절을 따른다.

## 이어 가기

`worker-retain`으로 남겨 두던 작업자(지적 수정을 원래 구현자에게 보낼 때, 재검토를 같은 검토자에게 맡길 때, 질문에 답할 때)는 같은 세션을 이어서 쓴다.

| 에이전트 | 방법 |
| --- | --- |
| Claude | SendMessage로 그 에이전트 ID에 보낸다 |
| Codex | `codex exec resume <세션 ID> "<메시지>"`를 같은 옵션(`-C`는 빼고 worktree에서 실행, `-c service_tier` 다시 판단)으로 백그라운드 실행 |
| OpenCode | `cd <worktree> && opencode run --standalone -s <세션 ID> --auto "<메시지>"` |

## 정리

- 작업자 정리(`worker-release`)는 할 일이 없다. 백그라운드 작업이 남아 있으면 끝내고 정리한다.
- worktree 삭제 조건은 SKILL.md 6단계 6과 같다. 지울 때는 `git -C <메인 저장소> worktree remove <worktree>`, 병합된 브랜치는 `git -C <메인 저장소> branch -D <브랜치>`(squash·rebase 병합이면 `-d`가 거부하므로 위 조건을 확인한 뒤 `-D`).
- 클라우드 컨테이너는 오래 쉬면 회수될 수 있다. 진행 상황은 `state.md`와 이슈·PR로 이어 가므로, 단계가 바뀔 때마다 `state.md`를 고친다는 규칙을 꼭 지킨다.

## GitHub

클라우드 세션의 GitHub 프록시는 GraphQL을 막는다. `gh issue list/view/comment/edit`, `gh pr list/view/create/merge`, `gh repo view`, `gh label list`는 403이 난다. `gh api`(REST)로 바꾼다. `{o}/{r}`은 저장소다.

| 로컬 명령 | 클라우드 |
| --- | --- |
| `gh issue list --label <라벨>` | `gh api "repos/{o}/{r}/issues?state=open&labels=<라벨>&per_page=100" --jq '.[] \| select(.pull_request \| not) \| {number, title}'` |
| `gh issue view <n> --comments` | `gh api repos/{o}/{r}/issues/<n>`과 `gh api repos/{o}/{r}/issues/<n>/comments` |
| `gh issue comment <n> --body "..."` | `gh api repos/{o}/{r}/issues/<n>/comments -f body="..."` |
| `gh issue edit <n> --add-label <라벨>` | `gh api repos/{o}/{r}/issues/<n>/labels -f "labels[]=<라벨>"` |
| `gh issue edit <n> --remove-label <라벨>` | `gh api -X DELETE repos/{o}/{r}/issues/<n>/labels/<라벨>` |
| `gh pr list --state open --search ...` | `gh api "repos/{o}/{r}/pulls?state=open&per_page=100" --jq '.[] \| {number, title, head: .head.ref}'` |
| `gh pr create` | `git push -u origin <브랜치>` 뒤 `gh api repos/{o}/{r}/pulls -f title="..." -f head=<브랜치> -f base=main -F body=@<본문 파일>` |
| `gh pr view <PR> --json state` | `gh api repos/{o}/{r}/pulls/<PR> --jq '{state, merged}'`(`merged`가 true면 `MERGED`) |
| `gh pr view <PR> --comments`와 리뷰 | `gh api repos/{o}/{r}/issues/<PR>/comments`, `gh api repos/{o}/{r}/pulls/<PR>/reviews`, `gh api repos/{o}/{r}/pulls/<PR>/comments` |
| `gh pr merge <PR> --<방법> --subject "..."` | `gh api -X PUT repos/{o}/{r}/pulls/<PR>/merge -f merge_method=<방법> -f commit_title="..."` 뒤 `git push origin --delete <브랜치>` |
| `gh repo view --json mergeCommitAllowed,...` | `gh api repos/{o}/{r} --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'` |
| `gh label list` | `gh api "repos/{o}/{r}/labels?per_page=100" --jq '.[].name'` |

- PR 본문은 Write 도구로 파일에 쓰고 `-F body=@<파일>`로 넘긴다(셸 인용에서 한국어·백틱이 깨지지 않게).
- `gh api`가 403/404면 이 세션에 그 저장소 권한이 없는 것이다. 사용자에게 알린다.

## 클라우드에서 못 하는 것

- **실창 검사**: 데스크톱이 없다. 프로젝트 설정에 "실창 검사" 절이 있으면 그 검사는 하지 않고, 모든 해당 항목을 보고의 "사람이 직접 확인할 항목"으로 넘긴다. 데스크톱 없이 찍는 스크린샷은 그대로 쓴다.
- **Claude 한도 측정**: [limits.md](limits.md)의 클라우드 절.
