"""
MySQL 连接与元数据查询工具。

@author Y77H
@date 2026-08-06
"""

import mysql.connector

from constant.app_constant import DB_CONNECT_TIMEOUT


DB_TYPES = {
    'mysql': {'label': 'MySQL', 'defaultPort': 3306},
}


def connect_db(config):
    """
    创建 MySQL 连接。

    @param config 例如：{'host': '127.0.0.1', 'port': 3306, 'user': 'root'}
    @return 例如：MySQLConnection
    """
    db_type = config.get('dbType', 'mysql')
    if db_type not in DB_TYPES:
        raise ValueError(f'不支持的数据库类型: {db_type}')
    return mysql.connector.connect(
        host=config.get('host', '127.0.0.1'),
        port=int(config.get('port') or DB_TYPES[db_type]['defaultPort']),
        user=config.get('user', 'root'),
        password=config.get('password', ''),
        database=config.get('database', ''),
        charset='utf8mb4',
        connection_timeout=DB_CONNECT_TIMEOUT,
        read_timeout=60,
        write_timeout=60,
        autocommit=False,
    )


def quote_identifier(name):
    """
    安全引用 MySQL 标识符。

    @param name 例如：gas_daily
    @return 例如：`gas_daily`
    """
    value = str(name or '')
    if not value or '\x00' in value or len(value) > 64:
        raise ValueError(f'无效的数据库标识符: {value!r}')
    return f"`{value.replace('`', '``')}`"


def close_quietly(*resources):
    """静默关闭游标或连接。@param resources 例如：cursor, connection。@return 例如：None。"""
    for resource in resources:
        if resource is None:
            continue
        try:
            resource.close()
        except Exception:
            pass

