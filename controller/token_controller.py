"""
Token 页面与接口控制器。

@author Y77H
@date 2026-08-06
"""

from flask import Blueprint, current_app, jsonify, render_template, request

from service import log_service
from service.token_service import TOOL_CONFIGS, token_service


token_blueprint = Blueprint('token', __name__)


@token_blueprint.get('/token')
def token_page():
    """渲染 Token 页面。@return 例如：text/html。"""
    return render_template(
        'token.html', modules=current_app.config['MODULES'], active_module='token',
    )


@token_blueprint.get('/api/tokens')
def get_tokens():
    """返回 Token 聚合数据。@param tool 例如：claude。@return 例如：{'summary': {}}。"""
    tool = request.args.get('tool', 'claude')
    if tool != 'all' and tool not in TOOL_CONFIGS:
        return jsonify({'error': f'未知工具: {tool}'}), 400
    try:
        apply_settings = request.args.get('raw') != '1'
        force_refresh = request.args.get('refresh') == '1'
        return jsonify(token_service.get_report(tool, apply_settings, force_refresh))
    except Exception as error:
        log_service.add(log_service.ERR, 'token', f'Token 数据加载失败: {error}')
        return jsonify({'error': str(error)}), 500


@token_blueprint.get('/api/token-tools')
def get_token_tools():
    """返回实际存在有效记录的工具标签。@return 例如：[{'name': 'codex', 'label': 'Codex'}]。"""
    try:
        return jsonify(token_service.get_available_tools())
    except Exception as error:
        log_service.add(log_service.ERR, 'token', f'Token 工具发现失败: {error}')
        return jsonify({'error': str(error)}), 500


@token_blueprint.get('/api/token-tool-catalog')
def get_token_tool_catalog():
    """返回固定顺序的全部工具及发现状态。@return 例如：[{'name': 'codex'}]。"""
    try:
        return jsonify(token_service.get_tool_catalog())
    except Exception as error:
        log_service.add(log_service.ERR, 'token', f'Token 工具目录加载失败: {error}')
        return jsonify({'error': str(error)}), 500


@token_blueprint.get('/api/config')
def get_token_config():
    """读取 Token 设置。@return 例如：{'trae-intl': 'D:/Trae'}。"""
    return jsonify(token_service.get_settings())


@token_blueprint.post('/api/config')
def save_token_config():
    """保存 Token 设置。@return 例如：{'ok': True}。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': '无效的请求数据'}), 400
    token_service.save_settings(data)
    log_service.add(log_service.INFO, 'token', 'Token 设置已保存')
    return jsonify({'ok': True})
