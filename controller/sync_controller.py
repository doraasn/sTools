"""
数据同步页面与接口控制器。

@author Y77H
@date 2026-08-06
"""

import json

from flask import Blueprint, Response, current_app, jsonify, render_template, request

from service import log_service
from service.sync_service import sync_service
from task.sync_task import sync_task
from util.db_util import DB_TYPES


sync_blueprint = Blueprint('sync', __name__)


def _body():
    """读取 JSON 对象请求体。@return 例如：{'name': '开发'}。"""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


@sync_blueprint.get('/sync')
def sync_page():
    """渲染同步页面。@return 例如：text/html。"""
    return render_template(
        'sync.html', modules=current_app.config['MODULES'], active_module='sync',
    )


@sync_blueprint.get('/api/sync/config')
def get_sync_config():
    """返回当前配置。@return 例如：{'config': {'name': '开发'}}。"""
    result = sync_service.get_active()
    return jsonify(result) if result else (jsonify({'error': '无配置'}), 404)


@sync_blueprint.post('/api/sync/config')
def save_sync_config():
    """保存当前配置。@return 例如：{'ok': True}。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400
    result = sync_service.save_active(data.get('config'), data.get('tableConfig'))
    return jsonify(result), (400 if result.get('error') else 200)


@sync_blueprint.get('/api/sync/db-types')
def get_db_types():
    """返回支持的数据库类型。@return 例如：{'mysql': {'defaultPort': 3306}}。"""
    return jsonify(DB_TYPES)


@sync_blueprint.get('/api/sync/config/exists')
def sync_config_exists():
    """返回是否存在有效配置。@return 例如：{'exists': True}。"""
    return jsonify({'exists': sync_service.config_exists()})


@sync_blueprint.get('/api/sync/configs')
def list_sync_configs():
    """返回连接配置名称。@return 例如：['开发']。"""
    return jsonify(sync_service.list_configs())


@sync_blueprint.post('/api/sync/config/switch')
def switch_sync_config():
    """切换连接配置。@return 例如：{'config': {'name': '开发'}}。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400
    result = sync_service.switch_config(data.get('name', ''))
    return jsonify(result) if result else (jsonify({'error': '配置不存在'}), 404)


@sync_blueprint.post('/api/sync/config/create')
def create_sync_config():
    """新建连接配置。@return 例如：{'ok': True}。"""
    data = _body()
    name = (data or {}).get('name', '').strip()
    if not name:
        return jsonify({'error': '配置名不能为空'}), 400
    if not sync_service.create_config(name):
        return jsonify({'error': '配置名已存在'}), 409
    log_service.add(log_service.OK, 'sync', f'创建连接配置: {name}')
    return jsonify({'ok': True})


@sync_blueprint.post('/api/sync/config/rename')
def rename_sync_config():
    """重命名连接配置。@return 例如：{'name': '测试'}。"""
    data = _body()
    name = (data or {}).get('name', '').strip()
    result = sync_service.rename_config(name)
    return jsonify(result) if result else (jsonify({'error': '重命名失败'}), 400)


@sync_blueprint.get('/api/sync/table-configs')
def list_table_configs():
    """返回表配置名称。@return 例如：['默认']。"""
    return jsonify(sync_service.list_table_configs(request.args.get('config')))


@sync_blueprint.post('/api/sync/table-config/switch')
def switch_table_config():
    """切换表配置。@return 例如：{'name': '默认', 'tables': {}}。"""
    data = _body()
    result = sync_service.switch_table_config((data or {}).get('name', ''))
    return jsonify(result) if result else (jsonify({'error': '表配置不存在'}), 404)


@sync_blueprint.post('/api/sync/table-config/create')
def create_table_config():
    """新建表配置。@return 例如：{'name': '全量', 'tables': {}}。"""
    data = _body()
    name = (data or {}).get('name', '').strip()
    if not name:
        return jsonify({'error': '名称不能为空'}), 400
    result = sync_service.create_table_config(name, data.get('copyFrom'))
    return jsonify(result) if result else (jsonify({'error': '表配置名已存在'}), 409)


@sync_blueprint.post('/api/sync/table-config/rename')
def rename_table_config():
    """重命名表配置。@return 例如：{'name': '归档'}。"""
    data = _body()
    result = sync_service.rename_table_config((data or {}).get('name', '').strip())
    return jsonify(result) if result else (jsonify({'error': '重命名失败'}), 400)


@sync_blueprint.post('/api/sync/test-connection')
def test_connection():
    """并行测试源库与目标库。@return 例如：{'source': {'ok': True}}。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400
    log_service.add(log_service.INFO, 'sync', '开始测试数据库连接')
    return jsonify(sync_service.test_connections(data))


@sync_blueprint.post('/api/sync/tables-all')
def get_tables_all():
    """返回源库全部表和列。@return 例如：{'tables': [], 'columns': {}}。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400
    try:
        return jsonify(sync_service.get_all_tables(data))
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@sync_blueprint.post('/api/sync/table-columns')
def get_table_columns():
    """返回指定表列。@return 例如：[{'name': 'id', 'type': 'bigint'}]。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400
    try:
        return jsonify(sync_service.get_table_columns(
            data.get('connection', {}), data.get('table', ''),
        ))
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@sync_blueprint.post('/api/sync/execute')
def execute_sync():
    """执行同步并返回 SSE 事件流。@return 例如：data: {'msg': '开始'}。"""
    data = _body()
    if data is None:
        return jsonify({'error': '无效的请求数据'}), 400

    def generate():
        for event in sync_task.run(
            data.get('source', {}), data.get('target', {}), data.get('tables', {}),
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return Response(
        generate(), mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    )

