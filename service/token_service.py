"""
Token 数据解析与聚合服务。

采用按文件修改时间缓存：每次刷新只重新解析发生变化的日志文件，避免周期性全量读取。

@author Y77H
@date 2026-08-06
"""

import json
import os
import re
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from service import log_service
from constant.app_constant import TEMP_DIR
from util import json_store


TOOL_CONFIGS = {
    'codex': {
        'dirs': [
            os.path.join(os.path.expanduser('~'), '.codex', 'sessions'),
            os.path.join(os.path.expanduser('~'), '.codex', 'archived_sessions'),
        ],
        'type': 'codex_jsonl',
        'label': 'Codex',
    },
    'mimocode': {
        'db': os.path.join(os.path.expanduser('~'), '.local', 'share', 'mimocode', 'mimocode.db'),
        'type': 'usage_db',
        'label': 'MimoCode',
        'exclude_imports': True,
    },
    'claude': {
        'dir': os.path.join(os.path.expanduser('~'), '.claude', 'projects'),
        'type': 'jsonl',
        'label': 'Claude',
    },
    'opencode': {
        'db': os.path.join(os.path.expanduser('~'), '.local', 'share', 'opencode', 'opencode.db'),
        'type': 'usage_db',
        'label': 'OpenCode',
    },
    'trae-cn': {
        'dirs': [os.path.join(os.environ.get('APPDATA', ''), 'Trae CN')],
        'type': 'trae_log',
        'label': 'Trae CN',
    },
    'trae-intl': {
        'dirs': [os.path.join(os.environ.get('APPDATA', ''), 'Trae')],
        'type': 'trae_log',
        'label': 'Trae',
    },
}
TOOL_ORDER = tuple(TOOL_CONFIGS)
RECORD_CACHE_SECONDS = 120

_clean_model_re = re.compile(r'<[^>]*>')
_short_prefix_re = re.compile(r'^[a-zA-Z]--')
_short_projects_re = re.compile(r'^Projects--')
_trae_start_re = re.compile(
    r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*token usage:\s*TokenUsageEvent\s*\{'
)
_trae_session_re = re.compile(r'session_id=(?:"([^"]+)"|([\w-]+))')
_trae_trace_re = re.compile(r'trace_id(?:=|:\s*)(?:"([^"]+)"|([\w-]+))')


def short_name(raw):
    """清理项目名称。@param raw 例如：C--Projects--demo。@return 例如：Projects/demo。"""
    value = _short_prefix_re.sub('', str(raw or ''))
    value = _short_projects_re.sub('', value)
    value = value.replace('--', '/')
    return value or str(raw or 'unknown')


def clean_model(raw):
    """清理模型名称。@param raw 例如：claude<beta>。@return 例如：claude。"""
    return _clean_model_re.sub('', str(raw or '')).strip()


class TokenService:
    """Token 数据服务。"""

    def __init__(self):
        self._file_cache = {}
        self._database_cache = {}
        self._record_cache = {}
        self._persistent_loaded = set()
        self._persistent_dirty = set()
        self._lock = threading.RLock()

    def get_settings(self):
        """读取 Token 设置。@return 例如：{'trae-intl': 'D:/Trae'}。"""
        return json_store.load_config('token', {})

    def save_settings(self, data):
        """保存 Token 设置。@param data 例如：{'hiddenTools': ['trae-cn']}。@return 例如：None。"""
        previous = self.get_settings()
        hidden_tools = data.get('hiddenTools', [])
        data['hiddenTools'] = [name for name in hidden_tools if name in TOOL_CONFIGS]
        json_store.save_config('token', data)

        # 工具显隐、项目别名等展示设置不影响原始日志，只在 Trae 路径变化时清理对应缓存。
        for tool in ('trae-intl', 'trae-cn'):
            if str(previous.get(tool, '')).strip() != str(data.get(tool, '')).strip():
                self.invalidate(f'trae:{tool}')

    def get_tool_catalog(self):
        """返回全部工具的发现与显示状态。@return 例如：[{'name': 'codex', 'hasData': True}]。"""
        hidden_tools = set(self.get_settings().get('hiddenTools', []))

        def inspect(name):
            config = TOOL_CONFIGS[name]
            try:
                # 工具目录只需要判断“是否有数据”，不应为每个来源生成完整报表。
                # 完整解析延迟到用户选中工具或“全部”后，避免首屏等待大型日志全部读完。
                has_data = self._has_tool_data(name, config)
            except Exception as error:
                has_data = False
                log_service.add(
                    log_service.WARN, 'token',
                    f"检查 {config['label']} Token 数据失败: {error}",
                )
            return {
                'name': name,
                'label': config['label'],
                'type': config['type'],
                'hasData': has_data,
                'visible': name not in hidden_tools,
            }

        # 各工具数据源互不依赖，并行发现可避免大型本地日志依次阻塞页面。
        with ThreadPoolExecutor(max_workers=min(6, len(TOOL_ORDER))) as executor:
            return list(executor.map(inspect, TOOL_ORDER))

    def get_available_tools(self):
        """
        并行检查本机存在有效 Token 数据的工具。
        @return 例如：[{'name': 'codex', 'label': 'Codex', 'records': 12}]
        """
        tools = [
            {'name': item['name'], 'label': item['label']}
            for item in self.get_tool_catalog() if item['hasData'] and item['visible']
        ]
        return ([{'name': 'all', 'label': '全部'}] + tools) if tools else []

    def _has_tool_data(self, tool, config):
        """快速判断工具是否至少存在一条有效记录。@return 例如：True。"""
        source_type = config.get('type')
        if source_type == 'usage_db':
            return _usage_database_has_data(
                config.get('db', ''), bool(config.get('exclude_imports')),
            )
        if source_type == 'codex_jsonl':
            return _directories_have_jsonl_usage(config.get('dirs', []), 'codex')
        if source_type == 'jsonl':
            return _directories_have_jsonl_usage([config.get('dir', '')], 'claude')
        if source_type == 'trae_log':
            settings = self.get_settings()
            configured = settings.get(tool)
            directories = [configured] if configured else config.get('dirs', [])
            return _directories_have_trae_usage(directories)
        return False

    def invalidate(self, kind=None):
        """清理文件缓存。@param kind 例如：trae。@return 例如：12。"""
        with self._lock:
            if not kind:
                count = len(self._file_cache) + len(self._database_cache) + len(self._record_cache)
                self._file_cache.clear()
                self._database_cache.clear()
                self._record_cache.clear()
                self._persistent_loaded.clear()
                self._persistent_dirty.clear()
                self._remove_persistent_cache()
                return count
            keys = [path for path, item in self._file_cache.items() if item.get('kind') == kind]
            for path in keys:
                self._file_cache.pop(path, None)
            database_keys = [name for name in self._database_cache if name == kind]
            for name in database_keys:
                self._database_cache.pop(name, None)
            if kind.startswith('trae:'):
                self._record_cache.pop(kind.split(':', 1)[1], None)
                self._persistent_loaded.add(kind)
                self._persistent_dirty.discard(kind)
                self._remove_persistent_cache(kind)
            return len(keys) + len(database_keys)

    def get_report(self, tool, apply_settings=True, force_refresh=False):
        """
        获取指定工具的聚合报告。

        @param tool 例如：claude
        @return 例如：{'summary': {'grandTotal': 100}, 'cells': []}
        """
        if tool == 'all':
            return self._get_all_report(force_refresh)
        return aggregate_report(self._load_records(tool, apply_settings, force_refresh))

    def _load_records(self, tool, apply_settings=True, force_refresh=False):
        """加载单个工具的原始记录。@param tool 例如：codex。@return 例如：[{'total': 100}]。"""
        config = TOOL_CONFIGS.get(tool)
        if not config:
            raise ValueError(f'未知工具: {tool}')
        with self._lock:
            cached = self._record_cache.get(tool)
            cache_valid = cached and time.monotonic() - cached['loaded_at'] < RECORD_CACHE_SECONDS
            records = cached['records'] if cache_valid and not force_refresh else None
        if records is None:
            if config['type'] == 'jsonl':
                records = self._load_claude_records(config)
            elif config['type'] == 'trae_log':
                records = self._load_trae_records(tool, config)
            elif config['type'] == 'usage_db':
                records = self._load_usage_database_records(tool, config, force_refresh)
            elif config['type'] == 'codex_jsonl':
                records = self._load_codex_records(config)
            else:
                raise ValueError(f"不支持的数据源类型: {config['type']}")
            with self._lock:
                self._record_cache[tool] = {'loaded_at': time.monotonic(), 'records': records}
        if tool == 'claude' and apply_settings:
            records = self._apply_claude_settings(records)
        return records

    def _get_all_report(self, force_refresh=False):
        """并行聚合全部已显示工具。@return 例如：{'summary': {'grandTotal': 100}}。"""
        hidden_tools = set(self.get_settings().get('hiddenTools', []))
        tools = [name for name in TOOL_ORDER if name not in hidden_tools]
        if not tools:
            return aggregate_report([])

        def load(name):
            try:
                records = self._load_records(name, force_refresh=force_refresh)
                # 不同工具可能使用相同会话编号，汇总前增加来源前缀避免会话数被合并。
                return [{**record, 'sessionId': f"{name}:{record.get('sessionId', '')}"} for record in records]
            except Exception as error:
                log_service.add(
                    log_service.WARN, 'token',
                    f"汇总 {TOOL_CONFIGS[name]['label']} Token 数据失败: {error}",
                )
                return []

        with ThreadPoolExecutor(max_workers=min(4, len(tools))) as executor:
            groups = list(executor.map(load, tools))
        return aggregate_report([record for group in groups for record in group])

    def _apply_claude_settings(self, records):
        """应用 Claude 项目隐藏与别名设置。@return 例如：[{'project': '演示项目'}]。"""
        settings = self.get_settings()
        hidden = set(settings.get('hiddenProjects', []))
        aliases = settings.get('aliases', {})
        return [
            {**record, 'project': aliases.get(record.get('project'), record.get('project'))}
            for record in records if record.get('project') not in hidden
        ]

    def _cached_parse(self, path, kind, parser, *args):
        """按文件状态复用解析结果。@return 例如：[{'total': 100}]。"""
        try:
            stat = os.stat(path)
        except OSError:
            return []
        signature = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._file_cache.get(path)
            if cached and cached.get('signature') == signature:
                return cached['records']

        records = parser(path, *args)
        with self._lock:
            self._file_cache[path] = {
                'signature': signature,
                'records': records,
                'kind': kind,
            }
            if kind.startswith('trae:'):
                self._persistent_dirty.add(kind)
        return records

    def _drop_missing_cache(self, active_paths, kind):
        """删除已经不存在的文件缓存。@return 例如：3。"""
        with self._lock:
            stale = [
                path for path, item in self._file_cache.items()
                if item.get('kind') == kind and path not in active_paths
            ]
            for path in stale:
                self._file_cache.pop(path, None)
            if stale and kind.startswith('trae:'):
                self._persistent_dirty.add(kind)
            return len(stale)

    def _persistent_cache_path(self, kind):
        """
        返回持久解析缓存路径。

        @param kind 例如：trae:trae-cn
        @return 例如：C:/Users/demo/.dTools/temp/token-cache-trae-trae-cn.json
        @author Y77H
        @date 2026-08-06
        """
        safe_kind = re.sub(r'[^a-zA-Z0-9_-]+', '-', kind)
        return os.path.join(TEMP_DIR, f'token-cache-{safe_kind}.json')

    def _restore_persistent_cache(self, kind):
        """
        将 Trae 文件解析结果恢复到内存，程序重启后无需重新读取大日志。

        @param kind 例如：trae:trae-intl
        @return 例如：12
        @author Y77H
        @date 2026-08-06
        """
        with self._lock:
            if kind in self._persistent_loaded:
                return 0
            self._persistent_loaded.add(kind)
        try:
            with open(self._persistent_cache_path(kind), 'r', encoding='utf-8') as file:
                payload = json.load(file)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return 0

        restored = 0
        with self._lock:
            for path, item in (payload.get('files') or {}).items():
                signature = item.get('signature') or []
                records = item.get('records')
                if len(signature) != 2 or not isinstance(records, list):
                    continue
                self._file_cache[path] = {
                    'signature': (int(signature[0]), int(signature[1])),
                    'records': records,
                    'kind': kind,
                }
                restored += 1
        return restored

    def _save_persistent_cache(self, kind, active_paths):
        """
        原子保存 Trae 解析缓存，仅在文件变化后落盘。

        @param kind 例如：trae:trae-cn
        @param active_paths 例如：{'C:/logs/ai-agent_0_stdout.log'}
        @return 例如：True
        @author Y77H
        @date 2026-08-06
        """
        cache_path = self._persistent_cache_path(kind)
        with self._lock:
            if kind not in self._persistent_dirty and os.path.isfile(cache_path):
                return False
            files = {
                path: {
                    'signature': list(item['signature']),
                    'records': item['records'],
                }
                for path, item in self._file_cache.items()
                if path in active_paths and item.get('kind') == kind
            }
        os.makedirs(TEMP_DIR, exist_ok=True)
        temp_path = ''
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', encoding='utf-8', suffix='.json.tmp',
                prefix='token-cache-', dir=TEMP_DIR, delete=False,
            ) as file:
                temp_path = file.name
                json.dump({'version': 1, 'files': files}, file, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, cache_path)
            with self._lock:
                self._persistent_dirty.discard(kind)
            return True
        except OSError as error:
            log_service.add(log_service.WARN, 'token', f'保存 {kind} 解析缓存失败: {error}')
            return False
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    def _remove_persistent_cache(self, kind=None):
        """
        删除指定或全部 Trae 持久缓存。

        @param kind 例如：trae:trae-cn；None 表示全部
        @return 例如：2
        @author Y77H
        @date 2026-08-06
        """
        if not os.path.isdir(TEMP_DIR):
            return 0
        paths = [self._persistent_cache_path(kind)] if kind else [
            os.path.join(TEMP_DIR, name)
            for name in os.listdir(TEMP_DIR)
            if name.startswith('token-cache-trae-') and name.endswith('.json')
        ]
        removed = 0
        for path in paths:
            try:
                os.remove(path)
                removed += 1
            except FileNotFoundError:
                pass
            except OSError as error:
                log_service.add(log_service.WARN, 'token', f'删除解析缓存失败: {error}')
        return removed

    def _load_claude_records(self, config):
        """增量加载 Claude JSONL。@return 例如：[{'model': 'claude'}]。"""
        base_dir = config.get('dir', '')
        if not os.path.isdir(base_dir):
            return []

        records = []
        active_paths = set()
        changed = 0
        try:
            with os.scandir(base_dir) as projects:
                for project in projects:
                    if not project.is_dir():
                        continue
                    with os.scandir(project.path) as files:
                        for file in files:
                            if not file.is_file() or not file.name.endswith('.jsonl'):
                                continue
                            active_paths.add(file.path)
                            before = self._file_cache.get(file.path, {}).get('signature')
                            parsed = self._cached_parse(
                                file.path, 'claude', _parse_claude_file, project.name,
                            )
                            try:
                                stat = os.stat(file.path)
                                if before != (stat.st_mtime_ns, stat.st_size):
                                    changed += 1
                            except OSError:
                                pass
                            records.extend(parsed)
        except OSError as error:
            log_service.add(log_service.ERR, 'token', f'扫描 Claude 日志失败: {error}')

        self._drop_missing_cache(active_paths, 'claude')
        if changed:
            log_service.add(
                log_service.OK, 'token',
                f'Claude 增量解析完成: {len(records)} 条记录，更新 {changed} 个文件',
            )
        return records

    def _load_trae_records(self, tool, config):
        """增量加载 Trae 日志。@return 例如：[{'model': 'Trae'}]。"""
        settings = self.get_settings()
        configured = settings.get(tool)
        directories = [configured] if configured else config.get('dirs', [])
        paths = set()

        for base_dir in directories:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for root, dirnames, filenames in os.walk(base_dir):
                # Trae 日志只关心 Modular 分支，跳过明显无关且庞大的缓存目录。
                dirnames[:] = [name for name in dirnames if name not in {'Cache', 'GPUCache', 'node_modules'}]
                for filename in filenames:
                    if filename.startswith('ai-agent_') and filename.endswith('_stdout.log'):
                        paths.add(os.path.join(root, filename))

        records = []
        label = config.get('label', tool)
        cache_kind = f'trae:{tool}'
        self._restore_persistent_cache(cache_kind)
        for path in sorted(paths):
            records.extend(self._cached_parse(path, cache_kind, _parse_trae_file, label))
        self._drop_missing_cache(paths, cache_kind)
        self._save_persistent_cache(cache_kind, paths)

        if not paths:
            log_service.add(log_service.WARN, 'token', f'{label} 未找到可解析日志')
        return records

    def _load_codex_records(self, config):
        """增量加载 Codex 会话 JSONL。@return 例如：[{'model': 'gpt-5.6-sol'}]。"""
        paths = set()
        for base_dir in config.get('dirs', []):
            if not os.path.isdir(base_dir):
                continue
            for root, _, filenames in os.walk(base_dir):
                for filename in filenames:
                    if filename.endswith('.jsonl'):
                        paths.add(os.path.join(root, filename))

        records = []
        for path in sorted(paths):
            records.extend(self._cached_parse(path, 'codex', _parse_codex_file))
        self._drop_missing_cache(paths, 'codex')
        return _deduplicate_records(records)

    def _load_usage_database_records(self, tool, config, force_refresh=False):
        """
        从 OpenCode/MimoCode SQLite 中读取逐消息 Token 用量。
        @param tool 例如：opencode
        @param config 例如：{'db': 'C:/Users/demo/opencode.db'}
        @param force_refresh 例如：True
        @return 例如：[{'model': 'mimo-v2.5', 'total': 1200}]
        """
        path = config.get('db', '')
        signature = _database_signature(path)
        if not signature:
            return []

        with self._lock:
            cached = self._database_cache.get(tool)
            if not force_refresh and cached and cached.get('signature') == signature:
                return cached['records']

        records = _parse_usage_database(path, bool(config.get('exclude_imports')))
        with self._lock:
            self._database_cache[tool] = {
                'signature': signature,
                'records': records,
            }
        return records


def _database_signature(path):
    """生成数据库及 WAL 文件签名。@param path 例如：C:/data/app.db。@return 例如：((1, 2), (3, 4))。"""
    if not path or not os.path.isfile(path):
        return None
    result = []
    for current in (path, f'{path}-wal'):
        try:
            stat = os.stat(current)
            result.append((stat.st_mtime_ns, stat.st_size))
        except OSError:
            result.append((0, 0))
    return tuple(result)


def _project_name(raw):
    """从工作目录提取项目名。@param raw 例如：C:/Projects/demo。@return 例如：demo。"""
    value = str(raw or '').rstrip('/\\')
    if not value:
        return 'unknown'
    return os.path.basename(value) or value


def _timestamp_date(raw):
    """将毫秒时间戳转换为本地日期。@param raw 例如：1786000000000。@return 例如：2026-08-06。"""
    try:
        value = float(raw)
        if value > 10_000_000_000:
            value /= 1000
        return datetime.fromtimestamp(value).astimezone().date().isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return ''


def _directories_have_jsonl_usage(directories, kind):
    """扫描到首条有效 JSONL 用量即停止。@param kind 例如：codex。@return 例如：True。"""
    for base_dir in directories:
        if not base_dir or not os.path.isdir(base_dir):
            continue
        for root, _, filenames in os.walk(base_dir):
            for filename in filenames:
                if not filename.endswith('.jsonl'):
                    continue
                path = os.path.join(root, filename)
                try:
                    file = open(path, 'r', encoding='utf-8', errors='ignore')
                except OSError:
                    continue
                with file:
                    for raw_line in file:
                        try:
                            event = json.loads(raw_line)
                        except json.JSONDecodeError:
                            continue
                        if kind == 'claude':
                            message = event.get('message') or {}
                            usage = message.get('usage') or event.get('usage') or {}
                            total = sum(int(usage.get(key, 0) or 0) for key in (
                                'input_tokens', 'output_tokens', 'cache_read_input_tokens',
                                'cache_creation_input_tokens',
                            ))
                        else:
                            payload = event.get('payload') or {}
                            usage = (payload.get('info') or {}).get('last_token_usage') or {}
                            total = int(usage.get('total_tokens', 0) or 0)
                        if total > 0:
                            return True
    return False


def _directories_have_trae_usage(directories):
    """扫描到首条有效 Trae 用量即停止。@return 例如：True。"""
    for base_dir in directories:
        if not base_dir or not os.path.isdir(base_dir):
            continue
        for root, dirnames, filenames in os.walk(base_dir):
            dirnames[:] = [name for name in dirnames if name not in {'Cache', 'GPUCache', 'node_modules'}]
            for filename in filenames:
                if not filename.startswith('ai-agent_') or not filename.endswith('_stdout.log'):
                    continue
                path = os.path.join(root, filename)
                try:
                    file = open(path, 'r', encoding='utf-8', errors='ignore')
                except OSError:
                    continue
                with file:
                    for line in file:
                        if (
                            re.search(r'prompt_tokens:\s*(?:Some\()?([1-9]\d*)', line)
                            or re.search(r'completion_tokens:\s*(?:Some\()?([1-9]\d*)', line)
                        ):
                            return True
    return False


def _usage_database_has_data(path, exclude_imports=False):
    """只读检查兼容数据库是否存在有效 Token 消息。@return 例如：True。"""
    if not path or not os.path.isfile(path):
        return False
    database_path = path.replace('\\', '/')
    try:
        connection = sqlite3.connect(f'file:{database_path}?mode=ro', uri=True, timeout=5)
        connection.execute('PRAGMA query_only = ON')
        tables = {
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        exclusion = ''
        if exclude_imports:
            imported_queries = []
            if 'external_import' in tables:
                imported_queries.append('SELECT session_id FROM external_import')
            if 'claude_import' in tables:
                imported_queries.append('SELECT session_id FROM claude_import')
            if imported_queries:
                exclusion = f" AND session_id NOT IN ({' UNION '.join(imported_queries)})"
        row = connection.execute(
            "SELECT 1 FROM message WHERE json_extract(data, '$.role') = 'assistant' "
            "AND json_extract(data, '$.tokens.total') > 0" + exclusion + ' LIMIT 1'
        ).fetchone()
        return row is not None
    except sqlite3.Error:
        return False
    finally:
        if 'connection' in locals():
            connection.close()


def _parse_usage_database(path, exclude_imports=False):
    """
    只读解析 OpenCode 兼容数据库中的助手消息用量。
    @param path 例如：C:/Users/demo/.local/share/opencode/opencode.db
    @param exclude_imports 例如：True
    @return 例如：[{'date': '2026-08-06', 'total': 100}]
    """
    records = []
    database_path = path.replace('\\', '/')
    uri = f'file:{database_path}?mode=ro'
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.Error as error:
        log_service.add(log_service.ERR, 'token', f'打开 Token 数据库失败: {error}')
        return records

    try:
        connection.execute('PRAGMA query_only = ON')
        tables = {
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        exclusion = ''
        if exclude_imports:
            imported_queries = []
            if 'external_import' in tables:
                imported_queries.append('SELECT session_id FROM external_import')
            if 'claude_import' in tables:
                imported_queries.append('SELECT session_id FROM claude_import')
            if imported_queries:
                exclusion = f" AND m.session_id NOT IN ({' UNION '.join(imported_queries)})"

        # data 只解析结构化 usage 字段；不读取 part 表中的提示词和回复正文。
        query = (
            'SELECT m.id, m.session_id, m.time_created, m.data, s.directory '
            'FROM message m LEFT JOIN session s ON s.id = m.session_id '
            "WHERE json_extract(m.data, '$.role') = 'assistant'" + exclusion
        )
        for message_id, session_id, created_at, raw_data, directory in connection.execute(query):
            try:
                data = json.loads(raw_data)
            except (TypeError, json.JSONDecodeError):
                continue
            tokens = data.get('tokens') or {}
            total = int(tokens.get('total', 0) or 0)
            if total <= 0:
                continue
            cache = tokens.get('cache') or {}
            model = data.get('modelID') or data.get('model') or ''
            if isinstance(model, dict):
                model = model.get('modelID') or model.get('id') or ''
            path_info = data.get('path') or {}
            timestamp = (data.get('time') or {}).get('created') or created_at
            input_tokens = int(tokens.get('input', 0) or 0)
            output_tokens = int(tokens.get('output', 0) or 0)
            reasoning_tokens = int(tokens.get('reasoning', 0) or 0)
            records.append({
                'date': _timestamp_date(timestamp),
                'model': clean_model(model),
                'project': _project_name(path_info.get('cwd') or directory),
                'sessionId': session_id or str(message_id),
                'input': input_tokens,
                # 推理 Token 属于生成阶段，合并进输出以保持图表分项与 total 一致。
                'output': output_tokens + reasoning_tokens,
                'cacheRead': int(cache.get('read', 0) or 0),
                'cacheCreate': int(cache.get('write', 0) or 0),
                'total': total,
            })
    except sqlite3.Error as error:
        log_service.add(log_service.ERR, 'token', f'查询 Token 数据库失败: {error}')
    finally:
        connection.close()
    return records


def _parse_codex_file(filepath):
    """逐行解析 Codex JSONL 的单次调用用量。@return 例如：[{'model': 'gpt-5.6-sol'}]。"""
    records = []
    model = ''
    project = 'unknown'
    session_id = ''
    try:
        file = open(filepath, 'r', encoding='utf-8', errors='ignore')
    except OSError:
        return records

    with file:
        for raw_line in file:
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            payload = event.get('payload') or {}
            if not isinstance(payload, dict):
                continue
            if event.get('type') == 'session_meta':
                session_id = payload.get('session_id') or payload.get('id') or session_id
                project = _project_name(payload.get('cwd'))
                continue
            if event.get('type') == 'turn_context':
                model = clean_model(payload.get('model')) or model
                project = _project_name(payload.get('cwd')) if payload.get('cwd') else project
                continue
            if event.get('type') != 'event_msg' or payload.get('type') != 'token_count':
                continue
            usage = (payload.get('info') or {}).get('last_token_usage') or {}
            total = int(usage.get('total_tokens', 0) or 0)
            timestamp = str(event.get('timestamp') or '')
            if total <= 0 or not timestamp:
                continue
            input_tokens = int(usage.get('input_tokens', 0) or 0)
            cache_read = int(usage.get('cached_input_tokens', 0) or 0)
            cache_create = int(usage.get('cache_write_input_tokens', 0) or 0)
            records.append({
                'date': timestamp[:10],
                'recordId': f'{session_id}:{timestamp}',
                'model': model or 'unknown',
                'project': project,
                'sessionId': session_id or os.path.basename(filepath),
                # Codex 的 cached_input_tokens 是 input_tokens 的子集，需先扣除再分项展示。
                'input': max(0, input_tokens - cache_read - cache_create),
                'output': int(usage.get('output_tokens', 0) or 0),
                'cacheRead': cache_read,
                'cacheCreate': cache_create,
                'total': total,
            })
    return records


def _deduplicate_records(records):
    """去除活动与归档目录中可能重复的记录。@return 例如：[{'total': 100}]。"""
    unique = {}
    for record in records:
        key = record.get('recordId') or id(record)
        unique[key] = record
    return list(unique.values())


def _parse_claude_file(filepath, project):
    """逐行解析 Claude JSONL。@return 例如：[{'date': '2026-08-06'}]。"""
    # Claude 会把同一条助手消息拆成多个 JSONL 事件；按 message.id 保留最终 usage。
    records_by_message = {}
    session_id = ''
    fallback_index = 0
    try:
        file = open(filepath, 'r', encoding='utf-8')
    except OSError:
        return []

    with file:
        for raw_line in file:
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if event.get('sessionId'):
                session_id = event['sessionId']

            message = event.get('message') or {}
            usage = None
            model = ''
            if event.get('type') in ('assistant', 'message'):
                if message.get('usage'):
                    usage = message['usage']
                    model = clean_model(message.get('model', ''))
                elif event.get('usage'):
                    usage = event['usage']
                    model = clean_model(event.get('model', ''))

            timestamp = event.get('timestamp')
            if not usage or not timestamp:
                continue

            input_tokens = usage.get('input_tokens', 0) or 0
            output_tokens = usage.get('output_tokens', 0) or 0
            cache_read = usage.get('cache_read_input_tokens', 0) or 0
            cache_create = usage.get('cache_creation_input_tokens', 0) or 0
            message_id = message.get('id') or event.get('uuid')
            if not message_id:
                fallback_index += 1
                message_id = f'event-{fallback_index}'
            records_by_message[message_id] = {
                'date': str(timestamp)[:10],
                'model': model or 'unknown',
                'project': short_name(project),
                'sessionId': session_id,
                'input': input_tokens,
                'output': output_tokens,
                'cacheRead': cache_read,
                'cacheCreate': cache_create,
                'total': input_tokens + output_tokens + cache_read + cache_create,
            }
    return list(records_by_message.values())


def _parse_trae_file(filepath, fallback_model='Trae'):
    """逐行解析 Trae stdout 日志。@return 例如：[{'model': 'Trae'}]。"""
    records = []
    buffer = ''
    current_timestamp = ''
    in_event = False
    event_index = 0

    def finish_event(body, timestamp, context=''):
        """完成单个用量事件。@param context 例如：session_id=abc。@return 例如：None。"""
        nonlocal event_index
        event_index += 1
        session_match = _trae_session_re.search(context)
        trace_match = _trae_trace_re.search(context)
        session_id = ''
        if session_match:
            session_id = session_match.group(1) or session_match.group(2)
        elif trace_match:
            session_id = trace_match.group(1) or trace_match.group(2)
        if not session_id:
            session_id = f'{os.path.basename(filepath)}:{event_index}'
        _append_trae_record(records, body, timestamp, session_id, fallback_model)

    try:
        file = open(filepath, 'r', encoding='utf-8', errors='ignore')
    except OSError:
        return records

    with file:
        for raw_line in file:
            line = raw_line.rstrip('\r\n')
            start_match = _trae_start_re.match(line)
            if start_match:
                remainder = line[start_match.end():]
                close_index = remainder.find('}')
                if close_index >= 0:
                    finish_event(
                        remainder[:close_index], start_match.group(1),
                        remainder[close_index + 1:],
                    )
                    in_event = False
                    continue
                buffer = remainder
                current_timestamp = start_match.group(1)
                in_event = True
                continue

            if not in_event:
                continue
            close_index = line.find('}')
            if close_index >= 0:
                finish_event(
                    buffer + '\n' + line[:close_index], current_timestamp,
                    line[close_index + 1:],
                )
                buffer = ''
                in_event = False
            elif len(buffer) < 1024 * 1024:
                buffer += '\n' + line
            else:
                buffer = ''
                in_event = False
    return records


def _append_trae_record(records, body, timestamp, session_id, fallback_model='Trae'):
    """追加一条 Trae Token 记录。@return 例如：None。"""
    def number(name):
        match = re.search(rf'{name}:\s*(?:Some\((\d+)\)|(\d+))', body)
        return int(match.group(1) or match.group(2)) if match else 0

    input_tokens = number('prompt_tokens')
    completion_tokens = number('completion_tokens')
    reasoning_tokens = number('reasoning_tokens')
    cache_read = number('cache_read_input_tokens')
    cache_create = number('cache_creation_input_tokens')
    reported_total = number('total_tokens')
    computed_total = (
        input_tokens + completion_tokens + reasoning_tokens + cache_read + cache_create
    )
    total = reported_total or computed_total
    # Trae 的 total_tokens 包含 reasoning_tokens；将非输入与非缓存部分统一计入输出。
    output_tokens = max(completion_tokens + reasoning_tokens, total - input_tokens - cache_read - cache_create)
    total = input_tokens + output_tokens + cache_read + cache_create
    model_match = re.search(r'name:\s*"([^"]*)"', body)
    model = clean_model(model_match.group(1) if model_match else '') or fallback_model
    records.append({
        'date': timestamp[:10],
        'model': model,
        'project': fallback_model,
        'sessionId': session_id,
        'input': input_tokens,
        'output': output_tokens,
        'cacheRead': cache_read,
        'cacheCreate': cache_create,
        'total': total,
    })


def aggregate_report(records):
    """聚合原始 Token 记录。@return 例如：{'summary': {'totalDays': 7}}。"""
    filtered = [
        record for record in records
        if record.get('model') and record['model'] != 'unknown' and record.get('total', 0) > 0
    ]
    cells = {}
    models = {}
    projects = {}
    sessions = set()
    dates = set()
    grand_total = 0

    for record in filtered:
        date = record['date']
        model = record['model']
        project = record['project']
        session = record.get('sessionId', '')
        key = (date, model, project)
        cell = cells.setdefault(key, _new_bucket(date=date, model=model, project=project))
        model_bucket = models.setdefault(model, _new_bucket(name=model))
        project_bucket = projects.setdefault(project, _new_bucket(name=project))

        for bucket in (cell, model_bucket, project_bucket):
            bucket['input'] += record['input']
            bucket['output'] += record['output']
            bucket['cacheRead'] += record['cacheRead']
            bucket['cacheCreate'] += record['cacheCreate']
            bucket['total'] += record['total']
            if session:
                bucket['_sessions'].add(session)

        grand_total += record['total']
        dates.add(date)
        if session:
            sessions.add(session)

    # 日期筛选在前端完成，单元格需携带会话编号以便筛选后重新去重统计。
    cell_list = [_public_bucket(item, include_session_ids=True) for item in cells.values()]
    cell_list.sort(key=lambda item: item['date'])
    model_list = [_public_bucket(item, grand_total) for item in models.values()]
    model_list.sort(key=lambda item: item['total'], reverse=True)
    project_list = [_public_bucket(item, grand_total) for item in projects.values()]
    project_list.sort(key=lambda item: item['total'], reverse=True)

    return {
        'summary': {
            'grandTotal': grand_total,
            'totalSessions': len(sessions),
            'totalDays': len(dates),
            'totalModels': len(models),
            'totalProjects': len(projects),
            'totalRecords': len(filtered),
        },
        'models': model_list,
        'projects': project_list,
        'cells': cell_list,
    }


def _new_bucket(**identity):
    """创建聚合桶。@return 例如：{'total': 0, '_sessions': set()}。"""
    return {
        **identity,
        'input': 0,
        'output': 0,
        'cacheRead': 0,
        'cacheCreate': 0,
        'total': 0,
        '_sessions': set(),
    }


def _public_bucket(bucket, grand_total=None, include_session_ids=False):
    """
    转换为 JSON 可序列化结构。

    @param bucket 例如：{'total': 100, '_sessions': {'session-1'}}
    @param grand_total 例如：1000
    @param include_session_ids 例如：True
    @return 例如：{'sessions': 1, 'sessionIds': ['session-1'], 'share': '10.0'}
    @author Y77H
    @date 2026-08-24
    """
    result = {key: value for key, value in bucket.items() if key != '_sessions'}
    result['sessions'] = len(bucket['_sessions'])
    if include_session_ids:
        result['sessionIds'] = sorted(str(value) for value in bucket['_sessions'])
    if grand_total is not None:
        result['share'] = f"{bucket['total'] / grand_total * 100:.1f}" if grand_total else '0.0'
    return result


token_service = TokenService()
