"""Claude 실제 한도를 잰다. Claude Code 로그인 토큰으로 사용량 API(/api/oauth/usage)를 읽는다.
로그인 정보는 $CLAUDE_CONFIG_DIR(없으면 ~/.claude)의 .credentials.json에 있다(Windows·Linux. macOS는 키체인이라 지원하지 않는다).
상태 표시줄이나 다른 플러그인에 기대지 않으므로 Orca·herdr 어디서나 같은 방법으로 잰다.

사용: python -I <check-limits 스킬 폴더>/scripts/claude_limit.py [--json]
종료 코드: 0 = 새 작업 가능, 1 = 한도 경고(사용률 80% 이상), 2 = 소진(100%) 또는 확인 실패
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import time
import urllib.error
import urllib.request

WARN_PERCENT = 80.0
CLAUDE_HOME = pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or pathlib.Path.home() / '.claude')
CREDENTIALS = CLAUDE_HOME / '.credentials.json'
# Claude Code의 /usage가 쓰는 조회. 문서에 없는 경로라 응답 모양이 바뀌면 unknown으로 알린다.
USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
# 자주 부르면 429로 막히므로 결과를 잠깐 보관한다. 조회가 실패하면 FALLBACK_SECONDS 안의 결과를 대신 쓴다.
# 계정(로그인 폴더)마다 따로 보관한다.
CACHE = (pathlib.Path(tempfile.gettempdir()) / 'agent-orchestra'
         / f"claude_usage-{hashlib.sha256(str(CLAUDE_HOME.resolve()).encode()).hexdigest()[:12]}.json")
CACHE_SECONDS = 60
FALLBACK_SECONDS = 10 * 60
WINDOWS = {'five_hour': 5 * 60, 'seven_day': 7 * 24 * 60}
RELOGIN = 'Claude Code를 한 번 실행해 로그인을 갱신하세요'


def read_cache():
    try:
        cached = json.loads(CACHE.read_text(encoding='utf-8'))
        return cached['body'], time.time() - float(cached['fetched_at'])
    except (OSError, ValueError, KeyError, TypeError):
        return None, None


def fetch_usage():
    """사용량 API 응답을 돌려준다. 실패하면 (None, 이유).
    토큰은 갱신하지 않는다. refresh token은 쓸 때마다 바뀌어서 여기서 갱신하면 Claude Code 로그인이 끊긴다."""
    try:
        oauth = json.loads(CREDENTIALS.read_text(encoding='utf-8'))['claudeAiOauth']
        token = oauth['accessToken']
    except (OSError, ValueError, KeyError, TypeError) as error:
        return None, f'{CREDENTIALS}에서 로그인 토큰을 읽을 수 없습니다: {error}'
    expires = oauth.get('expiresAt')
    if isinstance(expires, (int, float)) and expires / 1000 <= time.time():
        return None, f'로그인 토큰이 만료됐습니다. {RELOGIN}'
    request = urllib.request.Request(USAGE_URL, headers={
        'authorization': f'Bearer {token}',
        'anthropic-beta': 'oauth-2025-04-20',
        'accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        hint = f' {RELOGIN}' if error.code == 401 else ' 잠시 뒤 다시 재세요' if error.code == 429 else ''
        return None, f'사용량 API 실패: HTTP {error.code}.{hint}'
    except (OSError, ValueError) as error:
        return None, f'사용량 API 실패: {error}'
    if not isinstance(body, dict) or not any(isinstance(body.get(name), dict) for name in WINDOWS):
        return None, '사용량 API 응답에 five_hour·seven_day 창이 없음(응답 모양이 바뀌었을 수 있음)'
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps({'fetched_at': time.time(), 'body': body}), encoding='utf-8')
    except OSError:
        pass
    return body, None


def window(name, value):
    """비어 있는 창(아직 열리지 않은 5시간 창 등)은 None."""
    if not isinstance(value, dict) or value.get('utilization') is None:
        return None
    minutes = WINDOWS[name]
    resets_text = value.get('resets_at')
    resets, elapsed = None, None
    if resets_text:
        resets = datetime.datetime.fromisoformat(resets_text.replace('Z', '+00:00')).timestamp()
        # 창이 지난 비율. 사용률이 이보다 높으면 이 속도로는 초기화 전에 소진된다.
        elapsed = round(min(max(100 * (1 - (resets - time.time()) / (minutes * 60)), 0.0), 100.0), 1)
    return {
        'name': name,
        'used_percent': float(value['utilization']),
        'window_minutes': minutes,
        'resets_at': datetime.datetime.fromtimestamp(resets).strftime('%Y-%m-%d %H:%M') if resets else None,
        'elapsed_percent': elapsed,
        'locked': bool(value.get('locked_reason')),
    }


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    body, age = read_cache()
    source, api_error = 'cache', None
    if body is None or age > CACHE_SECONDS:
        fresh, api_error = fetch_usage()
        if fresh is not None:
            body, age, source = fresh, 0.0, 'usage-api'
        elif body is None or age > FALLBACK_SECONDS:
            print(json.dumps({'status': 'unknown', 'error': api_error}, ensure_ascii=False) if args.json
                  else f'확인 실패: {api_error}')
            return 2
    windows = [item for item in (window(name, body.get(name)) for name in WINDOWS) if item]
    highest = max((item['used_percent'] for item in windows), default=0.0)
    locked = any(item['locked'] for item in windows)
    status = 'exhausted' if locked or highest >= 100 else 'warning' if highest >= WARN_PERCENT else 'ok'
    measured = datetime.datetime.fromtimestamp(time.time() - age).strftime('%Y-%m-%d %H:%M')
    report = {'status': status, 'windows': windows, 'measured_at': measured, 'age_seconds': round(age),
              'source': source}
    if api_error:
        report['api_error'] = api_error
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for item in windows:
            print(f"{item['name']}: {item['used_percent']:.0f}% 사용 "
                  f"({item['elapsed_percent']}% 지남, 초기화 {item['resets_at']})")
        print(f"측정 {measured} ({report['age_seconds']}초 전), 판정: {status} ({source})")
    return {'ok': 0, 'warning': 1}.get(status, 2)


if __name__ == '__main__':
    sys.exit(main())
