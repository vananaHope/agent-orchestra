"""Claude 실제 한도를 읽는다. claude-hud가 Claude Code 상태 표시줄 입력의 rate_limits를
~/.claude/claude-usage.json에 내보낸다(`display.externalUsageWritePath`, 30초마다 갱신).

사용: python -I <스킬 폴더>/scripts/claude_limit.py [--json]
종료 코드: 0 = 새 작업 가능, 1 = 한도 경고(사용률 80% 이상), 2 = 소진(100%) 또는 확인 실패
"""
import argparse
import datetime
import json
import pathlib
import sys

WARN_PERCENT = 80.0
STALE_SECONDS = 10 * 60
SNAPSHOT = pathlib.Path.home() / '.claude' / 'claude-usage.json'


def local_time(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    try:
        snapshot = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
        updated = datetime.datetime.fromisoformat(snapshot['updated_at'].replace('Z', '+00:00'))
    except (OSError, ValueError, KeyError) as error:
        report = {'status': 'unknown', 'error': f'{SNAPSHOT}을 읽을 수 없습니다: {error}'}
        print(json.dumps(report, ensure_ascii=False) if args.json else report['error'])
        return 2
    age = (datetime.datetime.now(datetime.timezone.utc) - updated).total_seconds()
    windows = []
    for name in ('five_hour', 'seven_day'):
        value = snapshot.get(name) or {}
        if value.get('used_percentage') is not None:
            windows.append({'name': name, 'used_percent': float(value['used_percentage']),
                            'resets_at': local_time(value.get('resets_at'))})
    highest = max((item['used_percent'] for item in windows), default=None)
    if age > STALE_SECONDS or highest is None:
        status = 'unknown'
    else:
        status = 'exhausted' if highest >= 100 else 'warning' if highest >= WARN_PERCENT else 'ok'
    report = {'status': status, 'windows': windows, 'measured_at': local_time(snapshot['updated_at']),
              'age_seconds': round(age)}
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for item in windows:
            print(f"{item['name']}: {item['used_percent']:.0f}% 사용 (초기화 {item['resets_at']})")
        print(f"측정 {report['measured_at']} ({report['age_seconds']}초 전), 판정: {status}")
    return {'ok': 0, 'warning': 1}.get(status, 2)


if __name__ == '__main__':
    sys.exit(main())
