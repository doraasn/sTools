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

from flask import Flask, render_template, redirect

PORT = 3456
HOST = '127.0.0.1'
VERSION = 'v2.0'

# 确保 static 目录存在
_static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
os.makedirs(_static_dir, exist_ok=True)

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['TEMPLATES_AUTO_RELOAD'] = True
MODULES = []
MODULE_PRIORITY = ['token', 'sync', 'log']


def load_modules():
    """扫描 modules/ 目录，按优先级加载实现了 register(app) 的模块"""
    modules_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'modules')
    if not os.path.isdir(modules_dir):
        return

    # 收集所有可用模块名
    available = []
    for fname in os.listdir(modules_dir):
        if not fname.endswith('.py') or fname in ('__init__.py', 'common.py'):
            continue
        available.append(fname[:-3])

    # 按优先级排序：先在 MODULE_PRIORITY 中的按序排列，其余按字母序排到末尾
    def sort_key(name):
        try:
            return (0, MODULE_PRIORITY.index(name), '')
        except ValueError:
            return (1, 0, name)

    available.sort(key=sort_key)

    for mod_name in available:
        try:
            mod = importlib.import_module(f'modules.{mod_name}')
            if hasattr(mod, 'register') and hasattr(mod, 'MODULE_INFO'):
                mod.register(app)
                MODULES.append(mod.MODULE_INFO)
                app.config['MODULES'] = MODULES  # 供模板渲染侧边栏
                print(f'  ✓ 已加载模块: {mod.MODULE_INFO.get("label", mod_name)}')
        except Exception as e:
            print(f'  ✗ 加载模块 {mod_name} 失败: {e}')


@app.route('/')
def home():
    """重定向到 Token 看板"""
    return redirect('/token')


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

    try:
        app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
    except OSError as e:
        if 'Address already in use' in str(e) or '10048' in str(e):
            print(f'  ✗ 端口 {PORT} 已被占用，请关闭占用进程后重试')
        else:
            print(f'  ✗ 启动失败: {e}')
