---
name: configure
description: 이 프로젝트의 이슈 지휘 설정을 설정 창으로 만들거나 고친다.
disable-model-invocation: true
---

# 지휘 설정

이 스킬 폴더 옆의 `../orchestrate-issues/setup.md`를 읽고 그대로 한다.

- 프로젝트 설정(`docs/agents/orchestration.md` 또는 `.local/orchestration/settings.md`)이 없으면 처음부터 만든다.
- 있으면 먼저 `AskUserQuestion` 창 하나로 고칠 창을 고르게 한다. 질문 두 개, 둘 다 여러 개 고름이다. 선택지는 setup.md 2단계의 창 이름이고, 설명에 그 창이 채우는 절의 지금 값을 줄여 적는다.

  | 질문 | 선택지 |
  | --- | --- |
  | 저장소·병합 | 기본, 이슈, 작성 규칙 |
  | 작업 | 작업 나누기, 등급별 배치, 검토 배치, 명령 |

  - setup.md "절이 빠졌을 때" 표의 절이 빠졌으면, 그 절을 채우는 창의 설명 맨 앞에 "없음, 기본값 <값> 사용 중"을 적고 질문에도 빠진 절 이름을 적는다.
  - "훑기"로 채우는 절(스펙과 먼저 읽을 문서, 구현 제약, 확인 자료)이 빠졌으면 창으로 묻지 않고 훑어서 초안에 넣는다.
- 고른 창만 setup.md대로 띄운다. 선택지는 setup.md 2단계의 "선택지 표시"를 따른다.
- 저장 전에 setup.md의 마지막 확인 창을 띄운다.

**완료 기준**: setup.md의 완료 기준과 같다.
