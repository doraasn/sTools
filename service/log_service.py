"""
dTools 统一日志服务。

内存保留最近日志，磁盘按日持久化；清空操作同时清理内存和磁盘。

@author Y77H
@date 2026-08-06
"""

import json
import os
import threading
import time
from collections import deque

from constant.app_constant import LOG_DIR, LOG_RETENTION_DAYS, MAX_LOGS


INFO = 'info'
OK = 'ok'
WARN = 'warn'
ERR = 'err'

_logs = deque(maxlen=MAX_LOGS)
_lock = threading.RLock()


def _ensure_log_dir():
    """创建日志目录。@return 例如：None。"""
    os.makedirs(LOG_DIR, exist_ok=True)


def _daily_log_path(timestamp=None):
    """返回每日日志路径。@param timestamp 例如：1722900000。@return 例如：2026-08-06.jsonl。"""
    timestamp = timestamp or time.time()
    date_text = time.strftime('%Y-%m-%d', time.localtime(timestamp))
    return os.path.join(LOG_DIR, f'{date_text}.jsonl')


def add(level, source, message):
    """
    写入一条日志。

    @param level 例如：info
    @param source 例如：sync
    @param message 例如：开始同步 3 张表
    @return 例如：{'level': 'info', 'source': 'sync'}
    """
    entry = {
        'ts': time.time(),
        'time': time.strftime('%H:%M:%S'),
        'level': level if level in (INFO, OK, WARN, ERR) else INFO,
        'source': str(source),
        'msg': str(message),
    }
    with _lock:
        _logs.append(entry)
        try:
            _ensure_log_dir()
            with open(_daily_log_path(entry['ts']), 'a', encoding='utf-8') as file:
                file.write(json.dumps(entry, ensure_ascii=False) + '\n')
        except OSError:
            pass
    return entry


def get_all():
    """返回全部内存日志副本。@return 例如：[{'level': 'info'}]。"""
    with _lock:
        return list(_logs)


def get_since(timestamp):
    """返回指定时间后的日志。@param timestamp 例如：1722900000。@return 例如：[{'ts': 1722900001}]。"""
    with _lock:
        return [entry for entry in _logs if entry['ts'] > timestamp]


def clear():
    """清空内存和磁盘日志。@return 例如：3，表示删除 3 个日志文件。"""
    removed = 0
    with _lock:
        _logs.clear()
        try:
            _ensure_log_dir()
            for filename in os.listdir(LOG_DIR):
                if not filename.endswith('.jsonl'):
                    continue
                try:
                    os.remove(os.path.join(LOG_DIR, filename))
                    removed += 1
                except OSError:
                    pass
        except OSError:
            pass
    return removed


def _load_recent():
    """加载保留期内的日志并清理过期文件。@return 例如：120。"""
    _ensure_log_dir()
    cutoff = time.time() - LOG_RETENTION_DAYS * 86400
    loaded = 0
    with _lock:
        try:
            filenames = sorted(name for name in os.listdir(LOG_DIR) if name.endswith('.jsonl'))
        except OSError:
            return 0

        for filename in filenames:
            path = os.path.join(LOG_DIR, filename)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    continue
                with open(path, 'r', encoding='utf-8') as file:
                    for line in file:
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if entry.get('ts', 0) >= cutoff:
                            _logs.append(entry)
                            loaded += 1
            except OSError:
                continue
    return loaded


_load_recent()

