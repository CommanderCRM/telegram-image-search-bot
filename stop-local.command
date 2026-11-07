#!/bin/zsh
set -e
cd "${0:A:h}"
python3 - <<'PY'
import os
from pathlib import Path
import signal
import subprocess

lock=Path('.local/local-bot.lock')
if not lock.is_file():
    print('Бот уже остановлен.')
    raise SystemExit(0)
value=lock.read_text().strip()
if not value.isdigit():
    raise SystemExit('Некорректный PID: остановка отменена.')
pid=int(value)
process=subprocess.run(['/bin/ps','-p',str(pid),'-o','args='],capture_output=True,text=True)
if process.returncode or 'scripts/local-bot.mjs' not in process.stdout:
    raise SystemExit('Процесс бота по этому PID не найден; сигнал не отправлен.')
os.kill(pid,signal.SIGTERM)
print('Боту отправлен сигнал остановки.')
PY
