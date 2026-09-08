"""
数据同步配置与连接检查服务。

@author Y77H
@date 2026-08-06
"""

import copy
import threading
from concurrent.futures import ThreadPoolExecutor

from service import log_service
from util import json_store
from util.db_util import DB_TYPES, close_quietly, connect_db


class SyncService:
    """同步配置和数据库元数据服务。"""

    def __init__(self):
        self._config_lock = threading.RLock()

    def load_config(self):
        """读取完整同步配置。@return 例如：{'configs': {}, 'activeConfig': ''}。"""
        return json_store.load_config('sync', {
            'configs': {},
            'activeConfig': '',
            'activeTableConfig': {},
        })

    def save_config(self, config):
        """保存完整同步配置。@param config 例如：{'configs': {}}。@return 例如：None。"""
        json_store.save_config('sync', config)

    def get_active(self):
        """返回当前连接和表配置。@return 例如：{'config': {'name': '本地'}}。"""
        with self._config_lock:
            config = self.load_config()
            configs = config.get('configs', {})
            name = config.get('activeConfig', '')
            if name not in configs:
                name = next(iter(configs), '')
                if not name:
                    return None
                config['activeConfig'] = name

            entry = configs[name]
            table_configs = entry.get('tableConfigs', {})
            table_name = config.get('activeTableConfig', {}).get(name, '')
            if table_name not in table_configs:
                table_name = next(iter(table_configs), '')
                config.setdefault('activeTableConfig', {})[name] = table_name
            self.save_config(config)
            return {
                'config': {
                    'name': name,
                    'source': entry.get('source', {}),
                    'target': entry.get('target', {}),
                },
                'tableConfig': {
                    'name': table_name,
                    'tables': table_configs.get(table_name, {}).get('tables', {}),
                },
                'tableConfigNames': list(table_configs),
            }

    def config_exists(self):
        """判断是否存在有效连接配置。@return 例如：True。"""
        for entry in self.load_config().get('configs', {}).values():
            if entry.get('source', {}).get('host') or entry.get('target', {}).get('host'):
                return True
        return False

    def list_configs(self):
        """返回连接配置名称。@return 例如：['开发环境']。"""
        return list(self.load_config().get('configs', {}))

    def list_table_configs(self, config_name=None):
        """返回表配置名称。@param config_name 例如：开发环境。@return 例如：['默认']。"""
        config = self.load_config()
        config_name = config_name or config.get('activeConfig', '')
        entry = config.get('configs', {}).get(config_name, {})
        return list(entry.get('tableConfigs', {}))

    def create_config(self, name):
        """新建连接配置。@param name 例如：开发环境。@return 例如：True。"""
        with self._config_lock:
            config = self.load_config()
            if not name or name in config.get('configs', {}):
                return False
            config.setdefault('configs', {})[name] = {
                'source': {},
                'target': {},
                'tableConfigs': {'默认': {'tables': {}}},
            }
            config['activeConfig'] = name
            config.setdefault('activeTableConfig', {})[name] = '默认'
            self.save_config(config)
            return True

    def switch_config(self, name):
        """切换连接配置。@param name 例如：开发环境。@return 例如：{'config': {}}。"""
        with self._config_lock:
            config = self.load_config()
            if name not in config.get('configs', {}):
                return None
            config['activeConfig'] = name
            table_configs = config['configs'][name].get('tableConfigs', {})
            active_tables = config.setdefault('activeTableConfig', {})
            if active_tables.get(name) not in table_configs:
                active_tables[name] = next(iter(table_configs), '')
            self.save_config(config)
        return self.get_active()

    def rename_config(self, new_name, old_name=None):
        """
        重命名指定连接配置。

        @param new_name 例如：测试库
        @param old_name 例如：开发库；为空时使用当前配置
        @return 例如：{'name': '测试库'}
        @author Y77H
        @date 2026-08-24
        """
        with self._config_lock:
            config = self.load_config()
            old_name = old_name or config.get('activeConfig', '')
            configs = config.get('configs', {})
            if not old_name or not new_name or (new_name != old_name and new_name in configs):
                return None
            entry = configs.pop(old_name, None)
            if entry is None:
                return None
            configs[new_name] = entry
            config['activeConfig'] = new_name
            active_tables = config.setdefault('activeTableConfig', {})
            active_tables[new_name] = active_tables.pop(old_name, '')
            self.save_config(config)
            return {'ok': True, 'name': new_name}

    def save_active(
        self, connection_data, table_config_data,
        config_name=None, table_config_name=None,
    ):
        """
        保存指定连接和表配置，避免多标签页切换时写入其他方案。

        @param connection_data 例如：{'source': {'host': '127.0.0.1'}}
        @param table_config_data 例如：{'tables': {'demo': {'enable': True}}}
        @param config_name 例如：开发环境
        @param table_config_name 例如：近七天
        @return 例如：{'ok': True, 'configName': '开发环境'}
        @author Y77H
        @date 2026-08-24
        """
        with self._config_lock:
            config = self.load_config()
            active_name = config_name or config.get('activeConfig', '')
            configs = config.get('configs', {})
            if active_name not in configs:
                return {'error': '连接配置不存在或已被重命名'}
            entry = configs[active_name]
            if connection_data:
                entry.setdefault('source', {}).update(connection_data.get('source', {}))
                entry.setdefault('target', {}).update(connection_data.get('target', {}))
            if table_config_data:
                table_name = table_config_name or config.get('activeTableConfig', {}).get(active_name, '')
                table_configs = entry.get('tableConfigs', {})
                if table_name not in table_configs:
                    return {'error': '表策略不存在或已被重命名'}
                table_config = table_configs[table_name]
                # 表配置是完整快照，删除源库已经移除的旧表配置。
                table_config['tables'] = copy.deepcopy(table_config_data.get('tables', {}))
            self.save_config(config)
            return {
                'ok': True,
                'configName': active_name,
                'tableConfigName': table_config_name or config.get(
                    'activeTableConfig', {},
                ).get(active_name, ''),
            }

    def switch_table_config(self, name, config_name=None):
        """
        切换指定连接方案的表策略。

        @param name 例如：近七天
        @param config_name 例如：开发环境
        @return 例如：{'name': '近七天', 'tables': {}}
        @author Y77H
        @date 2026-08-24
        """
        with self._config_lock:
            config = self.load_config()
            active = config_name or config.get('activeConfig', '')
            entry = config.get('configs', {}).get(active, {})
            table_configs = entry.get('tableConfigs', {})
            if name not in table_configs:
                return None
            config.setdefault('activeTableConfig', {})[active] = name
            self.save_config(config)
            return {'name': name, 'tables': table_configs[name].get('tables', {})}

    def create_table_config(self, name, copy_from=None, config_name=None):
        """
        为指定连接方案新建表策略。

        @param name 例如：全量
        @param copy_from 例如：默认
        @param config_name 例如：开发环境
        @return 例如：{'name': '全量', 'tables': {}}
        @author Y77H
        @date 2026-08-24
        """
        with self._config_lock:
            config = self.load_config()
            active = config_name or config.get('activeConfig', '')
            entry = config.get('configs', {}).get(active, {})
            table_configs = entry.setdefault('tableConfigs', {})
            if not name or name in table_configs:
                return None
            source = table_configs.get(copy_from) if copy_from else None
            data = copy.deepcopy(source) if source else {'tables': {}}
            table_configs[name] = data
            config.setdefault('activeTableConfig', {})[active] = name
            self.save_config(config)
            return {'name': name, 'tables': data.get('tables', {})}

    def rename_table_config(self, new_name, config_name=None, old_name=None):
        """
        重命名指定连接方案的表策略。

        @param new_name 例如：归档
        @param config_name 例如：开发环境
        @param old_name 例如：近七天；为空时使用当前策略
        @return 例如：{'name': '归档'}
        @author Y77H
        @date 2026-08-24
        """
        with self._config_lock:
            config = self.load_config()
            active = config_name or config.get('activeConfig', '')
            entry = config.get('configs', {}).get(active, {})
            table_configs = entry.get('tableConfigs', {})
            old_name = old_name or config.get('activeTableConfig', {}).get(active, '')
            if not old_name or not new_name or (new_name != old_name and new_name in table_configs):
                return None
            data = table_configs.pop(old_name, None)
            if data is None:
                return None
            table_configs[new_name] = data
            config['activeTableConfig'][active] = new_name
            self.save_config(config)
            return {'name': new_name}

    def test_connections(self, data):
        """并行测试源库和目标库连接。@return 例如：{'source': {'ok': True}}。"""
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix='dtools-db-test') as executor:
            futures = {
                side: executor.submit(self._test_connection, side, data.get(side, {}))
                for side in ('source', 'target')
            }
            return {side: future.result() for side, future in futures.items()}

    def _test_connection(self, side, config):
        """测试单侧数据库连接。@return 例如：{'ok': True, 'tables': 20}。"""
        label = '源库' if side == 'source' else '目标库'
        if not config.get('host'):
            return {'ok': False, 'error': '未填写主机地址'}
        connection = cursor = None
        try:
            connection = connect_db(config)
            cursor = connection.cursor()
            cursor.execute('SELECT VERSION()')
            version = cursor.fetchone()[0]
            cursor.execute(
                'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s',
                (config.get('database', ''),),
            )
            count = cursor.fetchone()[0]
            log_service.add(log_service.OK, 'sync', f'{label}连接成功: {version}，{count} 张表')
            return {'ok': True, 'version': version, 'tables': count}
        except Exception as error:
            log_service.add(log_service.ERR, 'sync', f'{label}连接失败: {error}')
            return {'ok': False, 'error': str(error)}
        finally:
            close_quietly(cursor, connection)

    def get_all_tables(self, config):
        """批量返回指定库的表和列。@return 例如：{'tables': ['gas_daily'], 'columns': {}}。"""
        connection = cursor = None
        try:
            connection = connect_db(config)
            cursor = connection.cursor(dictionary=True)
            cursor.execute(
                "SELECT TABLE_NAME FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
                (config.get('database', ''),),
            )
            tables = [row['TABLE_NAME'] for row in cursor.fetchall()]
            columns = {name: [] for name in tables}
            if tables:
                cursor.execute(
                    "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = %s AND IS_GENERATED = 'NEVER' ORDER BY TABLE_NAME, ORDINAL_POSITION",
                    (config.get('database', ''),),
                )
                for row in cursor.fetchall():
                    columns.setdefault(row['TABLE_NAME'], []).append({
                        'name': row['COLUMN_NAME'],
                        'type': row['DATA_TYPE'],
                    })
            return {'tables': tables, 'columns': columns}
        finally:
            close_quietly(cursor, connection)

    def get_table_columns(self, config, table):
        """返回指定表的普通列。@return 例如：[{'name': 'id', 'type': 'bigint'}]。"""
        connection = cursor = None
        try:
            connection = connect_db(config)
            cursor = connection.cursor(dictionary=True)
            cursor.execute(
                "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND IS_GENERATED = 'NEVER' "
                "ORDER BY ORDINAL_POSITION",
                (config.get('database', ''), table),
            )
            return [
                {'name': row['COLUMN_NAME'], 'type': row['DATA_TYPE']}
                for row in cursor.fetchall()
            ]
        finally:
            close_quietly(cursor, connection)


sync_service = SyncService()
