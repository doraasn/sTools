"""
dTools 核心回归测试。

@author Y77H
@date 2026-08-06
"""

import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from app import app
from service.token_service import (
    TOOL_ORDER,
    TokenService,
    _parse_claude_file,
    _parse_codex_file,
    _parse_trae_file,
    _parse_usage_database,
    aggregate_report,
)
from task.sync_task import sync_task
from util.db_util import quote_identifier


class ApplicationTest(unittest.TestCase):
    """应用入口测试。"""

    def setUp(self):
        """创建 Flask 测试客户端。@return 例如：None。"""
        self.client = app.test_client()

    def test_health_and_pages(self):
        """验证健康检查和三个页面。@return 例如：None。"""
        for path in ('/token', '/sync', '/log'):
            self.assertEqual(200, self.client.get(path).status_code)
        response = self.client.get('/api/health')
        self.assertEqual(200, response.status_code)
        self.assertEqual('v3.0', response.get_json()['version'])
        self.assertEqual('nosniff', response.headers['X-Content-Type-Options'])

    def test_token_tools_endpoint(self):
        """工具标签接口仅返回已有数据的来源。@return 例如：None。"""
        tools = [{'name': 'codex', 'label': 'Codex'}]
        with patch('controller.token_controller.token_service.get_available_tools', return_value=tools):
            response = self.client.get('/api/token-tools')
        self.assertEqual(200, response.status_code)
        self.assertEqual(tools, response.get_json())

    def test_tool_catalog_endpoint(self):
        """工具目录接口保持固定顺序。@return 例如：None。"""
        catalog = [
            {'name': name, 'label': name, 'type': 'test', 'hasData': False, 'visible': True}
            for name in TOOL_ORDER
        ]
        with patch('controller.token_controller.token_service.get_tool_catalog', return_value=catalog):
            response = self.client.get('/api/token-tool-catalog')
        self.assertEqual(200, response.status_code)
        self.assertEqual(list(TOOL_ORDER), [item['name'] for item in response.get_json()])

    def test_all_tools_report_endpoint(self):
        """全部工具汇总入口可正常路由。@return 例如：None。"""
        report = {'summary': {'grandTotal': 123}, 'cells': [], 'models': [], 'projects': []}
        with patch('controller.token_controller.token_service.get_report', return_value=report) as mocked:
            response = self.client.get('/api/tokens?tool=all')
        self.assertEqual(200, response.status_code)
        self.assertEqual(123, response.get_json()['summary']['grandTotal'])
        mocked.assert_called_once_with('all', True, False)


class TokenServiceTest(unittest.TestCase):
    """Token 解析和聚合测试。"""

    def test_message_id_keeps_final_usage(self):
        """同一 message.id 只保留最终 usage。@return 例如：None。"""
        first = {
            'type': 'assistant', 'timestamp': '2026-08-06T10:00:00Z', 'sessionId': 's1',
            'message': {'id': 'm1', 'model': 'claude-test', 'usage': {'input_tokens': 10, 'output_tokens': 2}},
        }
        final = {
            'type': 'assistant', 'timestamp': '2026-08-06T10:00:01Z', 'sessionId': 's1',
            'message': {'id': 'm1', 'model': 'claude-test', 'usage': {'input_tokens': 10, 'output_tokens': 5}},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'sample.jsonl')
            with open(path, 'w', encoding='utf-8') as file:
                file.write(json.dumps(first) + '\n' + json.dumps(final) + '\n')
            records = _parse_claude_file(path, 'C--Projects--demo')
        self.assertEqual(1, len(records))
        self.assertEqual(15, records[0]['total'])

    def test_aggregate_report(self):
        """验证模型、项目和会话聚合。@return 例如：None。"""
        report = aggregate_report([
            {'date': '2026-08-06', 'model': 'm1', 'project': 'p1', 'sessionId': 's1', 'input': 10, 'output': 5, 'cacheRead': 20, 'cacheCreate': 0, 'total': 35},
            {'date': '2026-08-06', 'model': 'm1', 'project': 'p1', 'sessionId': 's1', 'input': 1, 'output': 2, 'cacheRead': 0, 'cacheCreate': 0, 'total': 3},
        ])
        self.assertEqual(38, report['summary']['grandTotal'])
        self.assertEqual(1, report['summary']['totalSessions'])
        self.assertEqual(1, report['models'][0]['sessions'])

    def test_codex_last_token_usage(self):
        """Codex 只使用单次调用 usage，并正确拆分缓存输入。@return 例如：None。"""
        events = [
            {'type': 'session_meta', 'payload': {'id': 's1', 'cwd': 'C:\\Projects\\demo'}},
            {'type': 'turn_context', 'payload': {'model': 'gpt-test', 'cwd': 'C:\\Projects\\demo'}},
            {
                'type': 'event_msg', 'timestamp': '2026-08-06T10:00:00Z',
                'payload': {'type': 'token_count', 'info': {'last_token_usage': {
                    'input_tokens': 100, 'cached_input_tokens': 60,
                    'output_tokens': 20, 'total_tokens': 120,
                }}},
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'codex.jsonl')
            with open(path, 'w', encoding='utf-8') as file:
                for event in events:
                    file.write(json.dumps(event) + '\n')
            records = _parse_codex_file(path)
        self.assertEqual(1, len(records))
        self.assertEqual('gpt-test', records[0]['model'])
        self.assertEqual(40, records[0]['input'])
        self.assertEqual(60, records[0]['cacheRead'])
        self.assertEqual(120, records[0]['total'])

    def test_usage_database_parser(self):
        """解析 OpenCode 兼容数据库的结构化用量字段。@return 例如：None。"""
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'usage.db')
            connection = sqlite3.connect(path)
            connection.execute('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)')
            connection.execute(
                'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)'
            )
            connection.execute('INSERT INTO session VALUES (?, ?)', ('s1', 'C:\\Projects\\demo'))
            data = {
                'role': 'assistant', 'modelID': 'mimo-test',
                'tokens': {'total': 150, 'input': 80, 'output': 20, 'reasoning': 10, 'cache': {'read': 40, 'write': 0}},
                'time': {'created': 1786000000000}, 'path': {'cwd': 'C:\\Projects\\demo'},
            }
            connection.execute(
                'INSERT INTO message VALUES (?, ?, ?, ?)',
                ('m1', 's1', 1786000000000, json.dumps(data)),
            )
            connection.commit()
            connection.close()
            records = _parse_usage_database(path)
        self.assertEqual(1, len(records))
        self.assertEqual('mimo-test', records[0]['model'])
        self.assertEqual(30, records[0]['output'])
        self.assertEqual(150, records[0]['total'])

    def test_trae_single_line_and_reasoning_tokens(self):
        """Trae 单行事件可解析，并将推理 Token 纳入总量。@return 例如：None。"""
        line = (
            '2026-08-06T10:00:00.000000+08:00 INFO token usage: TokenUsageEvent { '
            'name: "", prompt_tokens: 100, completion_tokens: 20, total_tokens: 150, '
            'reasoning_tokens: Some(30), cache_creation_input_tokens: Some(0), '
            'cache_read_input_tokens: Some(0), prompt_tokens_total: Some(0), '
            'completion_tokens_total: Some(0) }'
        )
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'ai-agent_0_stdout.log')
            with open(path, 'w', encoding='utf-8') as file:
                file.write(line + '\n')
            records = _parse_trae_file(path, 'Trae CN')
        self.assertEqual(1, len(records))
        self.assertEqual('Trae CN', records[0]['model'])
        self.assertEqual(50, records[0]['output'])
        self.assertEqual(150, records[0]['total'])

    def test_display_settings_keep_unrelated_parse_cache(self):
        """
        工具显隐和别名变化不能清空文件解析缓存。

        @return 例如：None
        @author Y77H
        @date 2026-08-06
        """
        service = TokenService()
        service._file_cache = {
            'trae.log': {'kind': 'trae:trae-intl', 'signature': (1, 1), 'records': []},
            'codex.jsonl': {'kind': 'codex', 'signature': (1, 1), 'records': []},
        }
        previous = {'trae-intl': 'D:/Trae', 'aliases': {}}
        updated = {'trae-intl': 'D:/Trae', 'aliases': {'demo': '演示'}, 'hiddenTools': ['claude']}
        with patch.object(service, 'get_settings', return_value=previous), \
                patch('service.token_service.json_store.save_config'):
            service.save_settings(updated)
        self.assertEqual({'trae.log', 'codex.jsonl'}, set(service._file_cache))

    def test_trae_path_change_only_invalidates_matching_cache(self):
        """
        Trae 路径变化只清理对应工具缓存。

        @return 例如：None
        @author Y77H
        @date 2026-08-06
        """
        service = TokenService()
        service._file_cache = {
            'intl.log': {'kind': 'trae:trae-intl', 'signature': (1, 1), 'records': []},
            'cn.log': {'kind': 'trae:trae-cn', 'signature': (1, 1), 'records': []},
            'codex.jsonl': {'kind': 'codex', 'signature': (1, 1), 'records': []},
        }
        with patch.object(service, 'get_settings', return_value={'trae-intl': 'D:/old'}), \
                patch.object(service, '_remove_persistent_cache'), \
                patch('service.token_service.json_store.save_config'):
            service.save_settings({'trae-intl': 'D:/new', 'hiddenTools': []})
        self.assertEqual({'cn.log', 'codex.jsonl'}, set(service._file_cache))

    def test_trae_persistent_cache_survives_service_restart(self):
        """
        Trae 解析结果可跨服务实例复用。

        @return 例如：None
        @author Y77H
        @date 2026-08-06
        """
        line = (
            '2026-08-06T10:00:00.000000+08:00 INFO token usage: TokenUsageEvent { '
            'name: "", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, '
            'reasoning_tokens: Some(0), cache_creation_input_tokens: Some(0), '
            'cache_read_input_tokens: Some(0) }'
        )
        with tempfile.TemporaryDirectory() as directory:
            source_dir = os.path.join(directory, 'logs')
            cache_dir = os.path.join(directory, 'temp')
            os.makedirs(source_dir)
            path = os.path.join(source_dir, 'ai-agent_0_stdout.log')
            with open(path, 'w', encoding='utf-8') as file:
                file.write(line + '\n')
            config = {'dirs': [source_dir], 'type': 'trae_log', 'label': 'Trae'}
            with patch('service.token_service.TEMP_DIR', cache_dir):
                first = TokenService()
                with patch.object(first, 'get_settings', return_value={}):
                    records = first._load_trae_records('trae-intl', config)
                self.assertEqual(1, len(records))

                second = TokenService()
                with patch.object(second, 'get_settings', return_value={}), \
                        patch('service.token_service._parse_trae_file', side_effect=AssertionError('不应重复解析')):
                    cached_records = second._load_trae_records('trae-intl', config)
                self.assertEqual(records, cached_records)


class SyncTaskTest(unittest.TestCase):
    """同步任务边界测试。"""

    def test_empty_task_does_not_connect_database(self):
        """无启用表时直接失败，不连接数据库。@return 例如：None。"""
        events = list(sync_task.run({}, {}, {}))
        self.assertIn('没有启用的数据表', events[0]['msg'])
        self.assertEqual('__DONE__', events[-1]['msg'])

    def test_identifier_quote(self):
        """验证 MySQL 标识符转义。@return 例如：None。"""
        self.assertEqual('`a``b`', quote_identifier('a`b'))
        with self.assertRaises(ValueError):
            quote_identifier('')


if __name__ == '__main__':
    unittest.main()
