"""
dTools 数据同步模块
MySQL 数据库间表级数据同步
@author y77h 2026-06-04
"""

import copy
import json
import time
from datetime import datetime, timedelta

import mysql.connector
from flask import Blueprint, Response, jsonify, render_template, request

from modules.common import load_json, save_json
from modules import log_collector

MODULE_INFO = {
    'name': 'sync',
    'label': '数据同步',
    'icon': '⇄',
    'description': 'MySQL 表级数据同步与配置管理',
    'accent': '#10b981',
}

sync_bp = Blueprint('sync', __name__)
CONFIG_FILE = 'sync_config.json'


# ========== 配置管理 ==========

def load_config():
    return load_json(CONFIG_FILE, {
        'configs': {}, 'activeConfig': '', 'activeTableConfig': {},
    })


def save_config(cfg):
    save_json(CONFIG_FILE, cfg)


def get_active():
    cfg = load_config()
    name = cfg.get('activeConfig', '')
    if not name or name not in cfg.get('configs', {}):
        names = list(cfg.get('configs', {}).keys())
        if names:
            name = names[0]
            cfg['activeConfig'] = name
            save_config(cfg)
        else:
            return None

    entry = cfg['configs'].get(name, {})
    tc_name = cfg.get('activeTableConfig', {}).get(name, '')
    tc_names = list(entry.get('tableConfigs', {}).keys())

    if not tc_name or tc_name not in tc_names:
        tc_name = tc_names[0] if tc_names else ''
        cfg.setdefault('activeTableConfig', {})[name] = tc_name
        save_config(cfg)

    tables = entry.get('tableConfigs', {}).get(tc_name, {}).get('tables', {})
    return {
        'config': {'name': name, 'source': entry.get('source', {}), 'target': entry.get('target', {})},
        'tableConfig': {'name': tc_name, 'tables': tables},
        'tableConfigNames': tc_names,
    }


def list_configs():
    return list(load_config().get('configs', {}).keys())


def list_table_configs(config_name=None):
    cfg = load_config()
    if not config_name:
        config_name = cfg.get('activeConfig', '')
    return list(cfg.get('configs', {}).get(config_name, {}).get('tableConfigs', {}).keys())


def switch_config(name):
    cfg = load_config()
    if name not in cfg.get('configs', {}):
        return None
    cfg['activeConfig'] = name
    tc_names = list(cfg['configs'][name].get('tableConfigs', {}).keys())
    if name not in cfg.get('activeTableConfig', {}):
        cfg.setdefault('activeTableConfig', {})[name] = tc_names[0] if tc_names else ''
    save_config(cfg)
    return get_active()


def create_config(name):
    cfg = load_config()
    if not name or name in cfg.get('configs', {}):
        return False
    cfg.setdefault('configs', {})[name] = {
        'source': {}, 'target': {},
        'tableConfigs': {'默认': {'tables': {}}},
    }
    cfg['activeConfig'] = name
    cfg.setdefault('activeTableConfig', {})[name] = '默认'
    save_config(cfg)
    return True


def rename_config(new_name):
    cfg = load_config()
    old_name = cfg.get('activeConfig', '')
    if not old_name or not new_name:
        return None
    if new_name != old_name and new_name in cfg.get('configs', {}):
        return None
    data = cfg['configs'].pop(old_name, None)
    if not data:
        return None
    cfg['configs'][new_name] = data
    cfg['activeConfig'] = new_name
    atc = cfg.get('activeTableConfig', {})
    if old_name in atc:
        atc[new_name] = atc.pop(old_name)
    save_config(cfg)
    return {'ok': True, 'name': new_name}


def switch_table_config(name):
    cfg = load_config()
    active_name = cfg.get('activeConfig', '')
    entry = cfg.get('configs', {}).get(active_name, {})
    if name not in entry.get('tableConfigs', {}):
        return None
    cfg.setdefault('activeTableConfig', {})[active_name] = name
    save_config(cfg)
    return {'name': name, 'tables': entry['tableConfigs'][name].get('tables', {})}


def create_table_config(name, copy_from=None):
    cfg = load_config()
    active_name = cfg.get('activeConfig', '')
    entry = cfg.get('configs', {}).get(active_name, {})
    if not name or name in entry.get('tableConfigs', {}):
        return None
    if copy_from and copy_from in entry.get('tableConfigs', {}):
        tc_data = copy.deepcopy(entry['tableConfigs'][copy_from])
    else:
        tc_data = {'tables': {}}
    entry.setdefault('tableConfigs', {})[name] = tc_data
    cfg.setdefault('activeTableConfig', {})[active_name] = name
    save_config(cfg)
    return {'name': name, 'tables': tc_data.get('tables', {})}


def rename_table_config(new_name):
    cfg = load_config()
    active_name = cfg.get('activeConfig', '')
    entry = cfg.get('configs', {}).get(active_name, {})
    old_name = cfg.get('activeTableConfig', {}).get(active_name, '')
    if not old_name or not new_name:
        return None
    if new_name != old_name and new_name in entry.get('tableConfigs', {}):
        return None
    data = entry['tableConfigs'].pop(old_name, None)
    if not data:
        return None
    entry['tableConfigs'][new_name] = data
    cfg['activeTableConfig'][active_name] = new_name
    save_config(cfg)
    return {'name': new_name}


def save_active_config(config_data, table_config_data):
    cfg = load_config()
    active_name = cfg.get('activeConfig', '')
    if not active_name:
        return {'error': '无激活配置'}
    entry = cfg.setdefault('configs', {}).setdefault(active_name, {})
    if config_data:
        entry.setdefault('source', {}).update(config_data.get('source', {}))
        entry.setdefault('target', {}).update(config_data.get('target', {}))
    if table_config_data:
        tc_name = cfg.get('activeTableConfig', {}).get(active_name, '默认')
        tc = entry.setdefault('tableConfigs', {}).setdefault(tc_name, {})
        tc.setdefault('tables', {}).update(table_config_data.get('tables', {}))
    save_config(cfg)
    return {'ok': True}


# ========== 数据库连接 ==========

def connect_db(cfg):
    return mysql.connector.connect(
        host=cfg.get('host', '127.0.0.1'),
        port=int(cfg.get('port', 3306)),
        user=cfg.get('user', 'root'),
        password=cfg.get('password', ''),
        database=cfg.get('database', 'gas_balance'),
        charset='utf8mb4',
    )


# ========== 路由 ==========

@sync_bp.route('/sync')
def sync_page():
    return render_template('sync.html')


@sync_bp.route('/api/sync/config', methods=['GET'])
def api_sync_config_get():
    result = get_active()
    if not result:
        return jsonify({'error': '无配置'}), 404
    return jsonify(result)


@sync_bp.route('/api/sync/config', methods=['POST'])
def api_sync_config_post():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    result = save_active_config(d.get('config'), d.get('tableConfig'))
    log_collector.add(log_collector.INFO, 'sync', '同步配置已保存')
    return jsonify(result)


@sync_bp.route('/api/sync/config/exists', methods=['GET'])
def api_sync_config_exists():
    cfg = load_config()
    for entry in cfg.get('configs', {}).values():
        if entry.get('source', {}).get('host') or entry.get('target', {}).get('host'):
            return jsonify({'exists': True})
    return jsonify({'exists': False})


@sync_bp.route('/api/sync/configs', methods=['GET'])
def api_sync_configs():
    return jsonify(list_configs())


@sync_bp.route('/api/sync/config/switch', methods=['POST'])
def api_sync_config_switch():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    result = switch_config(d.get('name', ''))
    if not result:
        return jsonify({'error': '配置不存在'}), 404
    log_collector.add(log_collector.INFO, 'sync', f'已切换配置: {d.get("name")}')
    return jsonify(result)


@sync_bp.route('/api/sync/config/create', methods=['POST'])
def api_sync_config_create():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': '配置名不能为空'}), 400
    if not create_config(name):
        return jsonify({'error': '配置名已存在'}), 409
    log_collector.add(log_collector.OK, 'sync', f'已创建配置: {name}')
    return jsonify({'ok': True})


@sync_bp.route('/api/sync/config/rename', methods=['POST'])
def api_sync_config_rename():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': '新名称不能为空'}), 400
    result = rename_config(name)
    if not result:
        return jsonify({'error': '重命名失败'}), 400
    return jsonify(result)


@sync_bp.route('/api/sync/table-configs', methods=['GET'])
def api_sync_table_configs():
    return jsonify(list_table_configs(request.args.get('config')))


@sync_bp.route('/api/sync/table-config/switch', methods=['POST'])
def api_sync_tc_switch():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    result = switch_table_config(d.get('name', ''))
    if not result:
        return jsonify({'error': '表配置不存在'}), 404
    return jsonify(result)


@sync_bp.route('/api/sync/table-config/create', methods=['POST'])
def api_sync_tc_create():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': '名称不能为空'}), 400
    result = create_table_config(name, d.get('copyFrom'))
    if not result:
        return jsonify({'error': '表配置名已存在'}), 409
    return jsonify(result)


@sync_bp.route('/api/sync/table-config/rename', methods=['POST'])
def api_sync_tc_rename():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    name = d.get('name', '').strip()
    if not name:
        return jsonify({'error': '新名称不能为空'}), 400
    result = rename_table_config(name)
    if not result:
        return jsonify({'error': '重命名失败'}), 400
    return jsonify(result)


@sync_bp.route('/api/sync/test-connection', methods=['POST'])
def api_test_connection():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    result = {'source': {}, 'target': {}}

    log_collector.add(log_collector.INFO, 'sync', '正在测试数据库连接...')

    for side in ('source', 'target'):
        conn_cfg = d.get(side, {})
        if not conn_cfg.get('host'):
            result[side] = {'ok': False, 'error': '未填写主机地址'}
            continue
        try:
            conn = connect_db(conn_cfg)
            cur = conn.cursor()
            cur.execute('SELECT VERSION()')
            version = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s",
                (conn_cfg.get('database', ''),)
            )
            tables = cur.fetchone()[0]
            cur.close()
            conn.close()
            result[side] = {'ok': True, 'version': version, 'tables': tables}
            label = '源库' if side == 'source' else '目标库'
            log_collector.add(log_collector.OK, 'sync', f'{label}连接成功: {version}, {tables} 张表')
        except Exception as e:
            result[side] = {'ok': False, 'error': str(e)}
            label = '源库' if side == 'source' else '目标库'
            log_collector.add(log_collector.ERR, 'sync', f'{label}连接失败: {e}')

    return jsonify(result)


@sync_bp.route('/api/sync/tables-all', methods=['POST'])
def api_tables_all():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    try:
        conn = connect_db(d)
        cur = conn.cursor(dictionary=True)

        cur.execute(
            "SELECT TABLE_NAME FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
            (d.get('database', ''),)
        )
        tables = [r['TABLE_NAME'] for r in cur.fetchall()]

        columns = {}
        if tables:
            cur.execute(
                "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = %s AND EXTRA NOT LIKE '%%VIRTUAL%%' ORDER BY ORDINAL_POSITION",
                (d.get('database', ''),)
            )
            for r in cur.fetchall():
                tbl = r['TABLE_NAME']
                if tbl not in columns:
                    columns[tbl] = []
                columns[tbl].append({'name': r['COLUMN_NAME'], 'type': r['DATA_TYPE']})

        cur.close()
        conn.close()
        return jsonify({'tables': tables, 'columns': columns})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@sync_bp.route('/api/sync/table-columns', methods=['POST'])
def api_table_columns():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400
    conn_cfg = d.get('connection', {})
    table = d.get('table', '')
    try:
        conn = connect_db(conn_cfg)
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND EXTRA NOT LIKE '%%VIRTUAL%%' "
            "ORDER BY ORDINAL_POSITION",
            (conn_cfg.get('database', ''), table)
        )
        cols = [{'name': r['COLUMN_NAME'], 'type': r['DATA_TYPE']} for r in cur.fetchall()]
        cur.close()
        conn.close()
        return jsonify(cols)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ========== 同步执行 ==========

@sync_bp.route('/api/sync/execute', methods=['POST'])
def api_sync_execute():
    d = request.get_json()
    if not d:
        return jsonify({'error': '无效的请求数据'}), 400

    source_cfg = d.get('source', {})
    target_cfg = d.get('target', {})
    tables = d.get('tables', {})
    enabled = {k: v for k, v in tables.items() if v.get('enable')}
    log_collector.add(log_collector.INFO, 'sync', f'开始同步 {len(enabled)} 张表...')

    def generate():
        yield _emit('▶ 开始同步...')
        total_add, total_upd = 0, 0
        start_time = time.time()

        for tbl_name, tbl_cfg in enabled.items():
            yield from _sync_table(source_cfg, target_cfg, tbl_name, tbl_cfg, totals := [0, 0])
            total_add += totals[0]
            total_upd += totals[1]
            yield _emit('')

        elapsed = time.time() - start_time
        yield _emit('━━━━━━━━━━━━━━━━━━━━━━━')
        yield _emit(f'✅ 完成！新增 {total_add} 条，更新 {total_upd} 条，耗时 {elapsed:.1f}s')
        log_collector.add(log_collector.OK, 'sync', f'同步完成: 新增 {total_add}, 更新 {total_upd}, 耗时 {elapsed:.1f}s')
        yield _emit('__DONE__')

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})


def _emit(msg):
    return f"data: {json.dumps({'msg': msg}, ensure_ascii=False)}\n\n"


def _sync_table(source_cfg, target_cfg, tbl_name, tbl_cfg, totals_ref):
    """同步单张表"""
    src_conn = dst_conn = None
    try:
        src_conn = connect_db(source_cfg)
        dst_conn = connect_db(target_cfg)
        src_cur = src_conn.cursor(dictionary=True)
        dst_cur = dst_conn.cursor()

        # 查询源表列
        src_cur.execute(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND EXTRA NOT LIKE '%%VIRTUAL%%' "
            "ORDER BY ORDINAL_POSITION",
            (source_cfg.get('database', ''), tbl_name)
        )
        col_rows = src_cur.fetchall()
        if not col_rows:
            yield _emit(f'⚠ [{tbl_name}] 源库中不存在，跳过')
            return

        columns = [r['COLUMN_NAME'] for r in col_rows]
        col_list = ', '.join(f'`{c}`' for c in columns)

        # 构建查询
        mode = tbl_cfg.get('mode', 'time')
        params = []
        if mode == 'all':
            query = f'SELECT * FROM `{tbl_name}`'
        else:
            time_range = tbl_cfg.get('timeRange', '')
            time_field = tbl_cfg.get('timeField', '')
            if time_range and '~' in time_range and time_field:
                parts = time_range.split('~')
                start = parts[0].strip()
                end = parts[1].strip()
                end_dt = datetime.strptime(end, '%Y-%m-%d') + timedelta(days=1)
                end_next = end_dt.strftime('%Y-%m-%d')
                # 验证日期格式后使用参数化查询
                datetime.strptime(start, '%Y-%m-%d')
                query = f"SELECT * FROM `{tbl_name}` WHERE `{time_field}` >= %s AND `{time_field}` < %s"
                params = [start, end_next]
            elif time_field:
                week_ago = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
                query = f"SELECT * FROM `{tbl_name}` WHERE `{time_field}` >= %s"
                params = [week_ago]
            else:
                query = f'SELECT * FROM `{tbl_name}`'

        yield _emit(f'▶ [{tbl_name}] 开始同步...')
        src_cur.execute(query, params)
        rows = src_cur.fetchall()

        if not rows:
            yield _emit(f'  ⏭ [{tbl_name}] 源库无数据')
            return

        # 构建 UPSERT SQL
        placeholders = ', '.join(['%s'] * len(columns))
        update_cols = [c for c in columns if c.lower() != 'id']
        if update_cols:
            update_clause = ', '.join(f'`{c}` = VALUES(`{c}`)' for c in update_cols)
            upsert_sql = (f"INSERT INTO `{tbl_name}` ({col_list}) VALUES ({placeholders}) "
                          f"ON DUPLICATE KEY UPDATE {update_clause}")
        else:
            upsert_sql = f"INSERT INTO `{tbl_name}` ({col_list}) VALUES ({placeholders})"

        # 批量插入
        BATCH_SIZE = 5000
        n_add, n_upd = 0, 0
        batch = []

        for row in rows:
            batch.append([row.get(c) for c in columns])
            if len(batch) >= BATCH_SIZE:
                dst_cur.executemany(upsert_sql, batch)
                dst_conn.commit()
                affected = dst_cur.rowcount
                # mysql-connector: rowcount = 插入行数 + 更新行数
                n_upd += max(affected - len(batch), 0)
                n_add += max(len(batch) - max(affected - len(batch), 0), 0)
                batch = []

        if batch:
            dst_cur.executemany(upsert_sql, batch)
            dst_conn.commit()
            affected = dst_cur.rowcount
            n_upd += max(affected - len(batch), 0)
            n_add += max(len(batch) - max(affected - len(batch), 0), 0)

        totals_ref[0] += n_add
        totals_ref[1] += n_upd
        yield _emit(f'  ✓ 源库 {len(rows)} 条 → 新增 {n_add} 更新 {n_upd}')
        log_collector.add(log_collector.OK, 'sync', f'[{tbl_name}] 完成: {len(rows)} 条 → 新增 {n_add} 更新 {n_upd}')

    except Exception as e:
        yield _emit(f'  ✗ [{tbl_name}] 错误: {str(e)}')
        log_collector.add(log_collector.ERR, 'sync', f'[{tbl_name}] 同步失败: {e}')
    finally:
        for conn in (src_conn, dst_conn):
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass


def register(app):
    app.register_blueprint(sync_bp)
