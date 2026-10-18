"""여러 작업자가 실창(실제 창) 검사를 차례로 하도록 데스크톱을 잠근다.

사용법:
    python desktop_lock.py run --owner issue-49 -- <실창 검사 명령...>
        잠금을 잡고 명령을 실행한 뒤 풀어 준다. 대부분 이것만 쓰면 된다.
    python desktop_lock.py acquire --owner issue-49
    python desktop_lock.py release --owner issue-49
    python desktop_lock.py status
    python desktop_lock.py install
        이 스크립트를 버전과 관계없는 ~/.agent-orchestra/bin/desktop_lock.py에 복사한다(같으면 그대로 둔다).
        저장소 문서·프로젝트 설정에는 그 고정 경로를 적는다.

잠금은 ~/.agent-orchestra/desktop.lock 하나다(데스크톱은 컴퓨터에 하나이므로 프로젝트와 플러그인 버전에 관계없이 같은 파일). 다른 작업자가 잡고 있으면 풀릴 때까지 기다린다.
잡은 지 STALE_SECONDS가 지난 잠금은 멈춘 작업자의 것으로 보고 넘겨받는다.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

LOCK = Path.home() / '.agent-orchestra' / 'desktop.lock'
INSTALLED = Path.home() / '.agent-orchestra' / 'bin' / 'desktop_lock.py'
STALE_SECONDS = 15 * 60
POLL_SECONDS = 5


def read():
    try:
        return json.loads(LOCK.read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError):
        return None


def acquire(owner, wait=True):
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    announced = False
    while True:
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            holder = read()
            if holder is None or time.time() - holder.get('since', 0) > STALE_SECONDS:
                print(f'오래된 잠금을 넘겨받습니다: {holder}', flush=True)
                LOCK.unlink(missing_ok=True)
                continue
            if holder.get('owner') == owner:
                return
            if not wait:
                raise SystemExit(f'데스크톱 사용 중: {holder["owner"]}')
            if not announced:
                print(f'데스크톱 대기: {holder["owner"]}이(가) 사용 중', flush=True)
                announced = True
            time.sleep(POLL_SECONDS)
            continue
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            json.dump({'owner': owner, 'since': time.time(), 'pid': os.getpid()}, file, ensure_ascii=False)
        print(f'데스크톱 잠금 획득: {owner}', flush=True)
        return


def release(owner):
    holder = read()
    if holder and holder.get('owner') == owner:
        LOCK.unlink(missing_ok=True)
        print(f'데스크톱 잠금 해제: {owner}', flush=True)


def install():
    source = Path(__file__).resolve()
    if source == INSTALLED.resolve():
        print(f'이미 고정 경로에서 실행 중: {INSTALLED}', flush=True)
        return
    content = source.read_bytes()
    if INSTALLED.exists() and INSTALLED.read_bytes() == content:
        print(f'고정 경로가 최신입니다: {INSTALLED}', flush=True)
        return
    INSTALLED.parent.mkdir(parents=True, exist_ok=True)
    temporary = INSTALLED.with_suffix('.tmp')
    temporary.write_bytes(content)
    os.replace(temporary, INSTALLED)
    print(f'고정 경로에 복사했습니다: {INSTALLED}', flush=True)


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    argv = sys.argv[1:]
    command = argv[argv.index('--') + 1:] if '--' in argv else []
    argv = argv[:argv.index('--')] if '--' in argv else argv
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('run', 'acquire', 'release', 'status', 'install'))
    parser.add_argument('--owner')
    args = parser.parse_args(argv)
    if args.action == 'install':
        install()
        return
    if args.action == 'status':
        holder = read()
        print(json.dumps(holder, ensure_ascii=False) if holder else '비어 있음')
        return
    if not args.owner:
        parser.error('--owner가 필요합니다(예: issue-49)')
    if args.action == 'acquire':
        acquire(args.owner)
    elif args.action == 'release':
        release(args.owner)
    else:
        if not command:
            parser.error('실행할 명령이 필요합니다: run --owner X -- <명령>')
        acquire(args.owner)
        try:
            sys.exit(subprocess.call(command))
        finally:
            release(args.owner)


if __name__ == '__main__':
    main()
