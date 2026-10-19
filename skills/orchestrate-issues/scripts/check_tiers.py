"""등급별 배치의 작업자 표기(에이전트[:모델][@강도])가 지금 쓸 수 있는 모델·강도인지 본다.

사용법:
    python -I check_tiers.py "opencode@low" "codex:gpt-6-astra@medium" "claude@high"

목록은 플러그인에 박아 두지 않고 각 도구가 스스로 갱신하는 것을 읽는다.
- Codex: $CODEX_HOME/models_cache.json(모델과 모델별 강도), 기본 모델은 $CODEX_HOME/config.toml의 model.
  CODEX_HOME이 없으면 ~/.codex다. Orca는 계정마다 CODEX_HOME을 따로 둔다.
- OpenCode: `opencode models`(모델만. 강도 variant는 목록이 없어 보지 않는다)
- Claude: 보지 않는다
- 관리자: 검토 목록에만 쓰는 표기라 보지 않는다

목록에 없는 이름은 막지 않고 경고로 낸다. 목록이 늦게 갱신됐을 수 있기 때문이다.
종료 코드: 0 = 모두 확인됨, 1 = 경고 있음
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CODEX = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')


def parse(notation):
    agent, _, effort = notation.partition('@')
    agent, _, model = agent.partition(':')
    return agent.strip(), model.strip() or None, effort.strip() or None


def codex_models():
    try:
        data = json.loads((CODEX / 'models_cache.json').read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError):
        return None
    return {item['slug']: [level['effort'] for level in item.get('supported_reasoning_levels') or []]
            for item in data.get('models', []) if item.get('slug')}


def codex_default_model():
    try:
        text = (CODEX / 'config.toml').read_text(encoding='utf-8')
    except FileNotFoundError:
        return None
    found = re.search(r'^model\s*=\s*"([^"]+)"', text.split('\n[', 1)[0], re.MULTILINE)
    return found.group(1) if found else None


def opencode_models():
    try:
        result = subprocess.run(['opencode', 'models'], capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=60, shell=sys.platform == 'win32')
    except (OSError, subprocess.TimeoutExpired):
        return None
    models = [line.strip() for line in result.stdout.splitlines() if '/' in line]
    return models or None


def unknown(kind, name, choices):
    near = difflib.get_close_matches(name, choices, n=1, cutoff=0.3)
    hint = f', 가까운 이름 `{near[0]}`' if near else ''
    return f'{kind} `{name}`이(가) 목록에 없음{hint}'


def check(notation, lists):
    agent, model, effort = parse(notation)
    if agent == 'codex':
        models = lists.setdefault('codex', codex_models())
        if models is None:
            return f'확인 못 함: {CODEX / "models_cache.json"} 없음'
        name = model or codex_default_model()
        if name not in models:
            return unknown('Codex 모델', name or '(기본 모델 없음)', list(models))
        if effort and models[name] and effort not in models[name]:
            return f'`{name}`의 강도 `{effort}`이(가) 목록에 없음(가능: {"/".join(models[name])})'
        return None
    if agent == 'opencode':
        if not model:
            return None
        models = lists.setdefault('opencode', opencode_models())
        if models is None:
            return '확인 못 함: `opencode models` 실패'
        if model not in models:
            return unknown('OpenCode 모델', model, models)
        return None
    if agent in ('claude', '관리자'):
        return None
    return f'에이전트 `{agent}`은(는) codex/opencode/claude/관리자가 아님'


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('notations', nargs='+')
    args = parser.parse_args()
    lists = {}
    warned = False
    for notation in args.notations:
        warning = check(notation, lists)
        warned = warned or warning is not None
        print(f'{notation}: {warning or "확인됨"}')
    return 1 if warned else 0


if __name__ == '__main__':
    sys.exit(main())
