"""Codex 실제 한도를 잰다. 먼저 Codex 로그인 토큰으로 사용량 API(/wham/usage)를 읽고, 안 되면 짧은 codex exec를
한 번 돌려 그 실행이 남긴 세션 기록의 rate_limits를 읽는다.
로그인 정보와 세션 기록은 $CODEX_HOME(없으면 ~/.codex)에 있다. Orca는 계정마다 CODEX_HOME을 따로 둔다.

사용: python -I <check-limits 스킬 폴더>/scripts/codex_limit.py [--json] [--exec]
  --exec  사용량 API를 건너뛰고 codex exec로 잰다.
종료 코드: 0 = 새 작업 가능, 1 = 한도 경고(사용률 80% 이상), 2 = 소진(100%) 또는 확인 실패
"""
import argparse
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

WARN_PERCENT = 80.0
CODEX_HOME = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
SESSIONS = CODEX_HOME / 'sessions'
# Codex의 /status가 쓰는 조회. 문서에 없는 경로라 바뀌면 codex exec로 넘어간다.
USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'


def usage_limits():
    """사용량 API로 rate_limits를 세션 기록과 같은 모양으로 만든다. 실패하면 (None, 이유).
    토큰은 갱신하지 않는다. refresh token은 쓸 때마다 바뀌어서 여기서 갱신하면 Codex 로그인이 끊긴다."""
    try:
        tokens = json.loads((CODEX_HOME / 'auth.json').read_text(encoding='utf-8'))['tokens']
        request = urllib.request.Request(USAGE_URL, headers={
            'authorization': f"Bearer {tokens['access_token']}",
            'chatgpt-account-id': tokens['account_id'],
            'originator': 'codex_cli_rs',
            'accept': 'application/json',
        })
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read())
    except (OSError, ValueError, KeyError, TypeError) as error:
        return None, f'사용량 API 실패: {error}'
    rate = body.get('rate_limit') if isinstance(body, dict) else None
    if not isinstance(rate, dict) or not isinstance(rate.get('primary_window'), dict):
        return None, '사용량 API 응답에 rate_limit.primary_window 없음'

    def convert(value):
        if not isinstance(value, dict) or value.get('used_percent') is None:
            return None
        seconds = value.get('limit_window_seconds')
        return {'used_percent': value['used_percent'],
                'window_minutes': round(seconds / 60) if seconds else None,
                'resets_at': value.get('reset_at')}

    reached = body.get('rate_limit_reached_type')
    if not reached and (rate.get('limit_reached') or rate.get('allowed') is False):
        reached = 'limit_reached'
    return {'primary': convert(rate['primary_window']), 'secondary': convert(rate.get('secondary_window')),
            'rate_limit_reached_type': reached, 'plan_type': body.get('plan_type')}, None


def exec_limits():
    """짧은 codex exec를 돌리고 그 세션 기록에서 rate_limits를 읽는다. 실패하면 (None, 이유)."""
    started = time.time() - 1
    with tempfile.TemporaryDirectory() as folder:
        result = subprocess.run(['codex', 'exec', '--skip-git-repo-check', 'Reply with just OK.'],
                                cwd=folder, capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=180, shell=sys.platform == 'win32')
    limits, path = latest_rate_limits(started)
    if limits is None:
        return None, (result.stderr or result.stdout)[-800:]
    return dict(limits, session=str(path)), None


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
    minutes = value.get('window_minutes')
    elapsed = None
    if resets and minutes:
        # 창이 지난 비율. 사용률이 이보다 높으면 이 속도로는 초기화 전에 소진된다.
        elapsed = round(min(max(100 * (1 - (resets - time.time()) / (minutes * 60)), 0.0), 100.0), 1)
    return {
        'name': name,
        'used_percent': float(value.get('used_percent') or 0.0),
        'window_minutes': minutes,
        'resets_at': datetime.datetime.fromtimestamp(resets).strftime('%Y-%m-%d %H:%M') if resets else None,
        'elapsed_percent': elapsed,
    }


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--exec', action='store_true', help='사용량 API를 건너뛰고 codex exec로 잰다')
    args = parser.parse_args()
    limits, api_error, source = None, None, 'exec'
    if not args.exec:
        limits, api_error = usage_limits()
        source = 'usage-api'
    if limits is None:
        limits, error = exec_limits()
        source = 'exec'
        if limits is None:
            message = {'status': 'unknown', 'error': error, **({'api_error': api_error} if api_error else {})}
            print(json.dumps(message, ensure_ascii=False) if args.json else f"확인 실패: {error}")
            return 2
    windows = [item for item in (window('primary', limits.get('primary')),
                                 window('secondary', limits.get('secondary'))) if item]
    highest = max((item['used_percent'] for item in windows), default=0.0)
    reached = limits.get('rate_limit_reached_type')
    status = 'exhausted' if reached or highest >= 100 else 'warning' if highest >= WARN_PERCENT else 'ok'
    report = {'status': status, 'windows': windows, 'rate_limit_reached_type': reached,
              'plan_type': limits.get('plan_type'), 'source': source}
    if 'session' in limits:
        report['session'] = limits['session']
    if api_error:
        report['api_error'] = api_error
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for item in windows:
            print(f"{item['name']}: {item['used_percent']:.0f}% 사용 "
                  f"(창 {item['window_minutes']}분, {item['elapsed_percent']}% 지남, 초기화 {item['resets_at']})")
        print(f"판정: {status} ({source})")
    return {'ok': 0, 'warning': 1}.get(status, 2)


if __name__ == '__main__':
    sys.exit(main())
