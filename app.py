"""
dTools — 开发工具集
主入口：Flask 应用、模块加载器、控制台菜单
@author y77h 2026-06-04
"""

import importlib
import os
import sys
import subprocess
import threading
import time
import webbrowser

# Windows 控制台 UTF-8 支持
if sys.platform == 'win32':
    os.system('chcp 65001 >nul 2>&1')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from flask import Flask, render_template

PORT = 3456
HOST = '127.0.0.1'
VERSION = 'v2.0'

app = Flask(__name__, static_folder='static', template_folder='templates')
MODULES = []

# 用于控制台 stop/restart 的服务线程引用
_server_thread = None
_server_ready = threading.Event()


def load_modules():
    """扫描 modules/ 目录，加载实现了 register(app) 的模块"""
    modules_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'modules')
    if not os.path.isdir(modules_dir):
        return

    for fname in sorted(os.listdir(modules_dir)):
        if not fname.endswith('.py') or fname in ('__init__.py', 'common.py'):
            continue
        mod_name = fname[:-3]
        try:
            mod = importlib.import_module(f'modules.{mod_name}')
            if hasattr(mod, 'register') and hasattr(mod, 'MODULE_INFO'):
                mod.register(app)
                MODULES.append(mod.MODULE_INFO)
                print(f'  ✓ 已加载模块: {mod.MODULE_INFO.get("label", mod_name)}')
        except Exception as e:
            print(f'  ✗ 加载模块 {mod_name} 失败: {e}')


@app.route('/')
def home():
    return render_template('index.html', modules=MODULES, version=VERSION, host=HOST, port=PORT)


def show_banner():
    """显示控制台 banner"""
    W = 30  # 内部宽度

    def pad_line(text):
        """根据可视宽度补空格（CJK 占 2 列）"""
        cn = sum(1 for c in text if '一' <= c <= '鿿')
        visual = len(text) + cn
        return text + ' ' * max(0, W - visual)

    names = ', '.join(m.get('label', m.get('name', '?')) for m in MODULES)
    url = f'http://{HOST}:{PORT}'

    print()
    print(f'  +{"-" * (W + 2)}+')
    print(f'  |  {pad_line(f"dTools  {VERSION}")}  |')
    print(f'  |  {pad_line(names)}  |')
    print(f'  |  {" " * W}  |')
    print(f'  |  {pad_line("-> " + url)}  |')
    print(f'  |  {" " * W}  |')
    print(f'  |  {pad_line("[O]浏览器  [Q]退出")}  |')
    print(f'  +{"-" * (W + 2)}+')
    print()


def open_browser():
    """打开默认浏览器"""
    url = f'http://{HOST}:{PORT}'
    try:
        webbrowser.open(url)
    except Exception:
        try:
            subprocess.Popen(['cmd', '/c', 'start', '', url], shell=False)
        except Exception:
            pass


def console_loop():
    """控制台按键监听"""
    try:
        import msvcrt
        while True:
            if msvcrt.kbhit():
                ch = msvcrt.getwch().lower()
                if ch == 'q':
                    print('\n  再见！')
                    sys.exit(0)
                elif ch == 'o':
                    open_browser()
            time.sleep(0.05)
    except ImportError:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print('\n  再见！')


if __name__ == '__main__':
    print('\n  dTools 启动中...\n')
    load_modules()

    if not MODULES:
        print('  ⚠ 未找到任何模块')

    # 控制台按键监听
    threading.Thread(target=console_loop, daemon=True).start()

    show_banner()

    # 延迟打开浏览器，等服务就绪
    def _delayed_open():
        time.sleep(0.5)
        open_browser()

    threading.Thread(target=_delayed_open, daemon=True).start()

    try:
        app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
    except OSError as e:
        if 'Address already in use' in str(e) or '10048' in str(e):
            print(f'  ✗ 端口 {PORT} 已被占用，请关闭占用进程后重试')
        else:
            print(f'  ✗ 启动失败: {e}')
