"""
dTools 统一日志收集器
线程安全的日志存储，供所有模块和日志页面使用
支持内存缓冲 + 文件持久化，7 天自动轮转
@author y77h 2026-06-04
"""

import json
import os
import threading
import time
from collections import deque

# 最大日志条数（内存上限）
MAX_LOGS = 2000

# 文件持久化目录
LOG_DIR = os.path.join(os.path.expanduser('~'), '.dTools', 'logs')

# 线程安全的日志缓冲区
_logs = deque(maxlen=MAX_LOGS)
_lock = threading.Lock()

# 日志级别
INFO = 'info'
OK = 'ok'
WARN = 'warn'
ERR = 'err'


def _ensure_log_dir():
    """确保日志目录存在"""
    os.makedirs(LOG_DIR, exist_ok=True)


def _daily_log_path(ts=None):
    """获取当天日志文件路径"""
    if ts is None:
        ts = time.time()
    date_str = time.strftime('%Y-%m-%d', time.localtime(ts))
    return os.path.join(LOG_DIR, f'{date_str}.jsonl')


def _load_from_disk():
    """启动时从磁盘加载最近 7 天的日志到内存"""
    _ensure_log_dir()
    cutoff = time.time() - 7 * 86400  # 7 天前的时间戳
    loaded = 0
    try:
        for fname in sorted(os.listdir(LOG_DIR)):
            if not fname.endswith('.jsonl'):
                continue
            fp = os.path.join(LOG_DIR, fname)
            try:
                with open(fp, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                            if entry.get('ts', 0) >= cutoff:
                                _logs.append(entry)
                                loaded += 1
                        except json.JSONDecodeError:
                            continue
            except Exception:
                continue
    except Exception:
        pass


def _cleanup_old_logs():
    """删除 7 天前的日志文件"""
    cutoff = time.time() - 7 * 86400
    try:
        for fname in os.listdir(LOG_DIR):
            if not fname.endswith('.jsonl'):
                continue
            fp = os.path.join(LOG_DIR, fname)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
            except OSError:
                pass
    except Exception:
        pass


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

    # 追加到当天 JSONL 文件
    try:
        _ensure_log_dir()
        fp = _daily_log_path()
        with open(fp, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception:
        pass  # 文件写入失败不影响内存操作


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


# 模块加载时：从磁盘恢复 + 清理过期文件
_load_from_disk()
_cleanup_old_logs()
