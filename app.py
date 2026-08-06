"""
dTools Flask 应用入口。

负责应用初始化、控制器注册、统一响应头和本地控制台生命周期。

@author Y77H
@date 2026-08-06
"""

import os
import signal
import subprocess
import sys
import threading
import time
import webbrowser

from flask import Flask, jsonify, redirect, request

from constant.app_constant import APP_NAME, APP_VERSION, HOST, MODULES, PORT
from controller import BLUEPRINTS


def create_app():
    """创建 Flask 应用。@return 例如：Flask('app')。"""
    application = Flask(__name__, static_folder='static', template_folder='templates')
    application.config.update(
        TEMPLATES_AUTO_RELOAD=True,
        MODULES=MODULES,
        JSON_AS_ASCII=False,
    )
    for blueprint in BLUEPRINTS:
        application.register_blueprint(blueprint)

    @application.get('/')
    def home():
        """进入默认工作台。@return 例如：302 /token。"""
        return redirect('/token')

    @application.get('/api/health')
    def health():
        """返回本地服务状态。@return 例如：{'status': 'ok', 'version': 'v3.0'}。"""
        return jsonify({
            'status': 'ok',
            'name': APP_NAME,
            'version': APP_VERSION,
            'modules': [module['name'] for module in MODULES],
        })

    @application.after_request
    def add_local_headers(response):
        """添加适合本地工具的基础安全响应头。@return 例如：Response。"""
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('X-Frame-Options', 'DENY')
        response.headers.setdefault('Referrer-Policy', 'no-referrer')
        if request.path.startswith('/api/') and 'Cache-Control' not in response.headers:
            response.headers['Cache-Control'] = 'no-store'
        return response

    @application.errorhandler(404)
    def not_found(_error):
        """处理不存在的接口。@return 例如：{'error': '接口不存在'}。"""
        if request.path.startswith('/api/'):
            return jsonify({'error': '接口不存在'}), 404
        return redirect('/token')

    return application


app = create_app()


def open_browser():
    """打开本地工作台。@return 例如：None。"""
    url = f'http://{HOST}:{PORT}'
    try:
        webbrowser.open(url)
    except Exception:
        try:
            subprocess.Popen(['cmd', '/c', 'start', '', url], shell=False)
        except Exception:
            pass


def stop_process():
    """结束当前本地服务进程。@return 例如：None。"""
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception:
        os._exit(0)


def console_loop():
    """监听 O 打开浏览器、Q 停止服务。@return 例如：None。"""
    try:
        import msvcrt
    except ImportError:
        return
    while True:
        if msvcrt.kbhit():
            key = msvcrt.getwch().lower()
            if key == 'q':
                stop_process()
                return
            if key == 'o':
                open_browser()
        time.sleep(0.05)


def show_banner():
    """显示启动信息。@return 例如：None。"""
    url = f'http://{HOST}:{PORT}'
    labels = ' · '.join(module['label'] for module in MODULES)
    print(f'\n  {APP_NAME} {APP_VERSION}')
    print(f'  {labels}')
    print(f'  {url}')
    print('  [O] 打开浏览器  [Q] 停止\n')


if __name__ == '__main__':
    if sys.platform == 'win32':
        os.system('chcp 65001 >nul 2>&1')
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    show_banner()
    threading.Thread(target=console_loop, name='dtools-console', daemon=True).start()
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False, threaded=True)
