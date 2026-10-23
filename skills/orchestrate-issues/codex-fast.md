# Codex fast

Codex fast(`service_tier`)는 같은 일을 1.5~2배 빨리 끝내지만 사용량을 더 쓴다. 배율은 모델마다 다르다(`$CODEX_HOME/models_cache.json`의 `service_tiers[].description`, `CODEX_HOME`이 없으면 `~/.codex`). 관리자는 Codex 작업자를 띄울 때마다 아래 기준으로 켤지 정한다. 프로젝트 설정에 "Codex fast" 절이 있으면 그 기준을 먼저 쓰고, 거기 없는 항목만 아래 기본값을 쓴다.

## 판단

구현, 검토, 2차 의견, 지적 수정, rebase 모두 Codex 작업자를 띄우는 순간에 정한다. 이미 떠 있는 작업자의 설정은 바꾸지 않는다.

1. **끄는 조건**을 먼저 본다. 하나라도 맞으면 끈다.
   - 짧은 창: `window_minutes`가 1440(하루) 이하인 창의 사용률이 문턱(기본 60%) 이상이다.
   - 긴 창 상한: 하루보다 긴 창의 사용률이 상한(기본 75%) 이상이다. 80%(`warning`)가 되면 Codex를 아예 건너뛰므로([tiers.md](tiers.md) "고르기") 그 전에 fast부터 끊는다.
   - 긴 창 속도: 하루보다 긴 창의 사용률이 하한(기본 40%) 이상이면서 그 창의 `elapsed_percent`(창이 지난 비율)보다 여유(기본 15%p) 넘게 높다. 이 속도로는 초기화 전에 다 쓴다는 뜻이다. 하한과 여유는 창 초반이나 잠깐 몰아 쓴 차이로 끄지 않게 둔다. 단, 초기화까지 24시간이 안 남았으면 이 조건은 보지 않는다. 남은 사용량은 초기화 때 사라지기 때문이다(상한은 그대로 본다).
   - 창 이름(`primary`·`secondary`)은 요금제마다 길이가 달라 보지 않는다. 창이 하나뿐인 요금제도 있다.
   - 동시 상한: fast로 떠 있는 Codex 작업자가 이미 상한(기본 3명)만큼 있다.
   - 모델: 그 모델이 fast를 지원하지 않는다(`check_tiers.py`가 경고한다).
   - 숫자는 [limits.md](limits.md)의 "재는 때"대로 잰 `check-limits` 결과를 쓴다. 30분 넘은 측정이면 다시 잰다.
2. **켜는 조건**을 본다. 하나라도 맞으면 켠다.
   - 검토: 주 검토, 2차 의견, 지적 수정 뒤 재검토. 검토가 끝나야 병합되고, 검토는 출력이 짧아 늘어나는 사용량이 작다.
   - 병합 직전: 지적 수정, rebase와 충돌 해결.
   - 임계 경로: 열린 다른 이슈가 이 이슈를 선행으로 기다리고(의존 관계나 `## Blocked by`), 지금 이 일 말고 진행 중이거나 시작할 수 있는 일이 없다.
   - 묶음의 마지막: 이번 묶음(wave)에서 끝나지 않은 일이 이것 하나다.
   - 사용자가 기다림: 사용자가 이 결과를 기다린다고 했거나 급하다고 했다.
3. 어디에도 들지 않으면 끈다. 다른 일과 나란히 도는 구현, 아무도 기다리지 않는 일이 여기에 든다.

켰으면 표기 끝에 `+fast`를 붙여 `state.md`와 맡김 기록([tiers.md](tiers.md))의 작업자 칸에 적고, `state.md`에는 켠 조건도 한 마디 적는다. 예: `작업자: codex@high+fast(검토)`. 껐으면 표기는 그대로 두고 `state.md`에만 끈 이유를 적는다. 예: `작업자: codex@high(fast 끔: 나란히 구현)`. 켬·끔 어느 쪽이든 기록이 없으면 판단을 건너뛴 것이다.

## 적용

Orca `worker-start`에는 Codex 설정을 넘길 옵션이 없다. Codex는 작업 폴더의 `.codex/config.toml`을 전역 설정보다 우선해 읽으므로 거기에 쓴다. 이 파일은 신뢰된 경로에서만 읽힌다(`$CODEX_HOME/config.toml`의 `[projects.'<경로>'] trust_level = "trusted"`. 상위 경로를 신뢰해도 된다).

1. worktree가 아직 없으면 먼저 만든다([opencode.md](opencode.md) "모델과 강도"의 1). 저장소에 이미 커밋된 `.codex/config.toml`이 있으면 쓰지 않고 전역 설정대로 띄운 뒤 사용자에게 알린다.
2. `<worktree>/.codex/config.toml`에 켜면 `service_tier = "fast"`, 끄면 `service_tier = "default"`를 쓴다. 끌 때도 파일을 지우지 않고 적는 것은 전역 설정이 fast일 수 있기 때문이다. 같은 worktree에 다음 Codex 작업자를 띄울 때마다 다시 정해 고친다.
3. 이 파일이 커밋되지 않게 메인 저장소의 `.git/info/exclude`에 `/.codex/`를 더한다(worktree가 함께 쓰는 파일이라 한 번이면 된다).
4. [tiers.md](tiers.md)의 "띄우기"대로 띄운다.
5. 작업자가 처음 응답하면 `$CODEX_HOME/sessions/`에서 `cwd`가 그 worktree인 가장 새 세션 기록의 `"service_tier"`를 본다. 켰으면 `priority`, 껐으면 `default`여야 한다. 다르면 신뢰 설정을 확인하고 사용자에게 알린다.
