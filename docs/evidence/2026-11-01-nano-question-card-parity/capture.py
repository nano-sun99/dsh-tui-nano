#!/usr/bin/env python3
"""Capture the actual Nano build in dedicated Ghostty windows; local mock, no model spend."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ghostty_visual', REPO / 'tests/e2e/ghostty-visual.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

def main():
    g.compile_list_windows()
    original_clipboard = subprocess.run(['pbpaste'], capture_output=True).stdout
    mock = subprocess.Popen(['node', 'tests/e2e/mock-model.mjs'], cwd=REPO, env={**os.environ, 'MOCK_SCRIPT': 'question-parity'}, stdout=subprocess.PIPE, text=True)
    port = int(mock.stdout.readline().strip().split()[-1])
    results = []
    try:
        for theme in ['dark', 'light']:
            for cols in [100, 60]:
                name = f'{theme}-{cols}-question'
                title = f'nano-125-{name}'
                home = g.ROOT / name
                home.mkdir()
                env = { 'HOME': str(home), 'DSH_HOME': str(home / '.dsh'), 'NANO_DATA_ROOT': str(home / '.nano'), 'NANO_THEME': theme, 'TERM': 'xterm-256color', 'DEEPSEEK_API_KEY': 'sk-test-00000000000000000000000000000000', 'DEEPSEEK_BASE_URL': f'http://127.0.0.1:{port}' }
                log = OUT / f'{name}.keys.txt'
                env['NANO_QUESTION_DRIVER_LOG'] = str(log)
                env['NODE_OPTIONS'] = f'--import={OUT}/drive.mjs'
                command = 'env ' + ' '.join(f'{key}={value}' for key,value in env.items()) + f' node {REPO}/dist/bin.js'
                try:
                    g.launch(title, command, cols - 2, 36, bg='#17191d' if theme == 'dark' else '#f6f3ed', fg='#e8e6e0' if theme == 'dark' else '#343945', cwd=str(home))
                    time.sleep(7)
                    g.capture(title, OUT / f'{name}.png')
                    results.append({'name': name, **g.image_check(OUT / f'{name}.png')})
                    if theme == 'dark' and cols == 100:
                        os.kill(int(log.read_text().splitlines()[0].split()[1]), signal.SIGUSR1)
                        time.sleep(.5)
                        os.kill(int(log.read_text().splitlines()[0].split()[1]), signal.SIGUSR2)
                        time.sleep(.8)
                        g.capture(title, OUT / 'dark-100-submit.png')
                finally:
                    g.close_window(title)
        (OUT / 'captures.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    finally:
        mock.terminate()
        mock.wait(timeout=5)
        subprocess.run(['pbcopy'], input=original_clipboard)
        shutil.rmtree(g.ROOT, ignore_errors=True)

if __name__ == '__main__':
    main()
