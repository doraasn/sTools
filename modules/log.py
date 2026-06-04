"""
dTools 日志查看模块
统一日志入口，支持搜索和高亮
@author y77h 2026-06-04
"""

from flask import Blueprint, current_app, jsonify, render_template, request

from modules import log_collector

MODULE_INFO = {
    'name': 'log',
    'label': '日志',
    'icon': '▤',
    'description': '统一日志查看：实时流、搜索过滤、关键词高亮',
    'accent': '#f59e0b',
}

log_bp = Blueprint('log', __name__)


@log_bp.route('/log')
def log_page():
    return render_template('log.html', modules=current_app.config.get('MODULES', []), active_module='log')


@log_bp.route('/api/logs')
def api_logs():
    """获取所有日志"""
    return jsonify(log_collector.get_all())


@log_bp.route('/api/logs/since')
def api_logs_since():
    """获取指定时间戳之后的日志（用于轮询增量更新）"""
    ts = request.args.get('ts', '0')
    try:
        ts = float(ts)
    except ValueError:
        ts = 0
    return jsonify(log_collector.get_since(ts))


@log_bp.route('/api/logs/clear', methods=['POST'])
def api_logs_clear():
    """清空日志"""
    log_collector.clear()
    return jsonify({'ok': True})


def register(app):
    app.register_blueprint(log_bp)
