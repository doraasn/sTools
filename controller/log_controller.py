"""
日志页面与接口控制器。

@author Y77H
@date 2026-08-06
"""

from flask import Blueprint, current_app, jsonify, render_template, request

from service import log_service


log_blueprint = Blueprint('log', __name__)


@log_blueprint.get('/log')
def log_page():
    """渲染日志页面。@return 例如：text/html。"""
    return render_template(
        'log.html', modules=current_app.config['MODULES'], active_module='log',
    )


@log_blueprint.get('/api/logs')
def get_logs():
    """返回全部内存日志。@return 例如：[{'level': 'info'}]。"""
    return jsonify(log_service.get_all())


@log_blueprint.get('/api/logs/since')
def get_logs_since():
    """返回时间戳后的增量日志。@param ts 例如：1722900000。@return 例如：[]。"""
    try:
        timestamp = float(request.args.get('ts', '0'))
    except (TypeError, ValueError):
        timestamp = 0
    return jsonify(log_service.get_since(timestamp))


@log_blueprint.post('/api/logs/clear')
def clear_logs():
    """清空内存与磁盘日志。@return 例如：{'ok': True, 'removedFiles': 2}。"""
    return jsonify({'ok': True, 'removedFiles': log_service.clear()})

