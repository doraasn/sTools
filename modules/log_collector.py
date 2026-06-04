"""
dTools 统一日志收集器
线程安全的日志存储，供所有模块和日志页面使用
@author y77h 2026-06-04
"""

import threading
import time
from collections import deque

# 最大日志条数
MAX_LOGS = 2000

# 线程安全的日志缓冲区
_logs = deque(maxlen=MAX_LOGS)
_lock = threading.Lock()

# 日志级别
INFO = 'info'
OK = 'ok'
WARN = 'warn'
ERR = 'err'


def add(level, source, msg):
    """添加一条日志

    Args:
        level: 日志级别 (info/ok/warn/err)
        source: 来源模块名 (如 'token', 'sync')
        msg: 日志消息
    """
    entry = {
        'ts': time.time(),
        'time': time.strftime('%H:%M:%S'),
        'level': level,
        'source': source,
        'msg': str(msg),
    }
    with _lock:
        _logs.append(entry)


def get_all():
    """获取所有日志（副本）"""
    with _lock:
        return list(_logs)


def get_since(ts):
    """获取指定时间戳之后的日志"""
    with _lock:
        return [e for e in _logs if e['ts'] > ts]


def clear():
    """清空日志"""
    with _lock:
        _logs.clear()
