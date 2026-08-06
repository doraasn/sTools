"""
dTools 应用常量。

@author Y77H
@date 2026-08-06
"""

import os


APP_NAME = 'dTools'
APP_VERSION = 'v3.0'
HOST = '127.0.0.1'
PORT = 3456

DATA_DIR = os.path.join(os.path.expanduser('~'), '.dTools')
TEMP_DIR = os.path.join(DATA_DIR, 'temp')
LOG_DIR = os.path.join(DATA_DIR, 'logs')
CONFIG_FILE = 'config.json'

MAX_LOGS = 3000
LOG_RETENTION_DAYS = 7
SYNC_BATCH_SIZE = 1000
DB_CONNECT_TIMEOUT = 8

MODULES = [
    {
        'name': 'token',
        'label': 'Token 分析',
        'shortLabel': 'Token',
        'icon': 'spark',
        'description': '多种本地 AI 编程工具用量洞察',
        'accent': '#3b82f6',
        'route': '/token',
    },
    {
        'name': 'sync',
        'label': '数据同步',
        'shortLabel': '同步',
        'icon': 'sync',
        'description': 'MySQL 表级数据迁移工作台',
        'accent': '#22c55e',
        'route': '/sync',
    },
    {
        'name': 'log',
        'label': '运行日志',
        'shortLabel': '日志',
        'icon': 'terminal',
        'description': '统一查看任务与系统事件',
        'accent': '#f59e0b',
        'route': '/log',
    },
]
