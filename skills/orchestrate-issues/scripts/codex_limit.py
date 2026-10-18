"""Codex 실제 한도를 잰다. 짧은 codex exec를 한 번 돌리고, 그 실행이 남긴 세션 기록의 rate_limits를 읽는다.

사용: python -I <스킬 폴더>/scripts/codex_limit.py [--json]
종료 코드: 0 = 새 작업 가능, 1 = 한도 경고(사용률 80% 이상), 2 = 소진(100%) 또는 확인 실패
"""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile
import time

WARN_PERCENT = 80.0
SESSIONS = pathlib.Path.home() / '.codex' / 'sessions'


def latest_rate_limits(since):
    files = [path for path in SESSIONS.rglob('*.jsonl') if path.stat().st_mtime >= since]
    for path in sorted(files, key=lambda item: item.stat().st_mtime, reverse=True):
        found = None
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            stack = [record]
            while stack:
                item = stack.pop()
                if isinstance(item, dict):
                    if isinstance(item.get('rate_limits'), dict):
                        found = item['rate_limits']
                    stack.extend(item.values())
                elif isinstance(item, list):
                    stack.extend(item)
        if found:
            return found, path
    return None, None


def window(name, value):
    if not value:
        return None
    resets = value.get('resets_at')
    return {
        'name': name,
        'used_percent': float(value.get('used_percent') or 0.0),
        'window_minutes': value.get('window_minutes'),
        'resets_at': datetime.datetime.fromtimestamp(resets).strftime('%Y-%m-%d %H:%M') if resets else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    started = time.time() - 1
    with tempfile.TemporaryDirectory() as folder:
        result = subprocess.run(['codex', 'exec', '--skip-git-repo-check', 'Reply with just OK.'],
                                cwd=folder, capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=180, shell=sys.platform == 'win32')
    limits, path = latest_rate_limits(started)
    if limits is None:
        message = {'status': 'unknown', 'error': (result.stderr or result.stdout)[-800:]}
        print(json.dumps(message, ensure_ascii=False) if args.json else f"확인 실패: {message['error']}")
        return 2
    windows = [item for item in (window('primary', limits.get('primary')),
                                 window('secondary', limits.get('secondary'))) if item]
    highest = max((item['used_percent'] for item in windows), default=0.0)
    reached = limits.get('rate_limit_reached_type')
    status = 'exhausted' if reached or highest >= 100 else 'warning' if highest >= WARN_PERCENT else 'ok'
    report = {'status': status, 'windows': windows, 'rate_limit_reached_type': reached,
              'plan_type': limits.get('plan_type'), 'session': str(path)}
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for item in windows:
            print(f"{item['name']}: {item['used_percent']:.0f}% 사용 "
                  f"(창 {item['window_minutes']}분, 초기화 {item['resets_at']})")
        print(f"판정: {status}")
    return {'ok': 0, 'warning': 1}.get(status, 2)


if __name__ == '__main__':
    sys.exit(main())
