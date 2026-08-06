"""
MySQL 数据同步调度任务。

每张表使用独立事务，源数据采用 fetchmany 流式读取；任一批次失败会回滚整张表。

@author Y77H
@date 2026-08-06
"""

import threading
import time
from datetime import datetime, timedelta

from constant.app_constant import SYNC_BATCH_SIZE
from service import log_service
from util.db_util import close_quietly, connect_db, quote_identifier


class SyncTask:
    """串行数据同步任务，避免本地重复点击产生并发写入。"""

    def __init__(self):
        self._run_lock = threading.Lock()

    def run(self, source_config, target_config, tables):
        """
        执行同步并逐条产生事件。

        @param source_config 例如：{'host': '127.0.0.1', 'database': 'source'}
        @param target_config 例如：{'host': '127.0.0.1', 'database': 'target'}
        @param tables 例如：{'gas_daily': {'enable': True, 'mode': 'all'}}
        @return 例如：迭代 {'msg': '开始同步', 'level': 'info'}
        """
        if not self._run_lock.acquire(blocking=False):
            yield self._event('已有同步任务正在运行', 'error', 'busy')
            yield self._event('__DONE__', 'error', 'failed')
            return

        source_connection = target_connection = None
        started_at = time.time()
        enabled = [(name, config) for name, config in tables.items() if config.get('enable')]
        success_count = failed_count = processed_total = affected_total = 0

        try:
            if not enabled:
                yield self._event('没有启用的数据表', 'error', 'failed')
                yield self._event('__DONE__', 'error', 'failed')
                return

            yield self._event(f'准备同步 {len(enabled)} 张表', 'info', 'running')
            source_connection = connect_db(source_config)
            target_connection = connect_db(target_config)
            source_connection.ping(reconnect=False, attempts=1, delay=0)
            target_connection.ping(reconnect=False, attempts=1, delay=0)
            yield self._event('源库与目标库连接就绪', 'success', 'running')

            for index, (table_name, table_config) in enumerate(enabled, start=1):
                yield self._event(
                    f'[{index}/{len(enabled)}] {table_name} 开始', 'info', 'running',
                    table=table_name,
                )
                result = yield from self._sync_table(
                    source_connection, target_connection,
                    source_config, target_config,
                    table_name, table_config,
                )
                processed_total += result['processed']
                affected_total += result['affected']
                if result['ok']:
                    success_count += 1
                else:
                    failed_count += 1

            elapsed = time.time() - started_at
            status = 'success' if failed_count == 0 else 'partial'
            level = 'success' if failed_count == 0 else 'warning'
            summary = (
                f'同步结束：成功 {success_count}，失败 {failed_count}，'
                f'读取 {processed_total} 行，影响 {affected_total} 行，耗时 {elapsed:.1f}s'
            )
            log_service.add(
                log_service.OK if failed_count == 0 else log_service.WARN,
                'sync', summary,
            )
            yield self._event(summary, level, status, summary={
                'success': success_count,
                'failed': failed_count,
                'processed': processed_total,
                'affected': affected_total,
                'elapsed': round(elapsed, 1),
            })
            yield self._event('__DONE__', level, status)
        except Exception as error:
            message = f'同步任务启动失败: {error}'
            log_service.add(log_service.ERR, 'sync', message)
            yield self._event(message, 'error', 'failed')
            yield self._event('__DONE__', 'error', 'failed')
        finally:
            close_quietly(source_connection, target_connection)
            self._run_lock.release()

    def _sync_table(
        self, source_connection, target_connection,
        source_config, target_config, table_name, table_config,
    ):
        """同步单张表并返回结果。@return 例如：{'ok': True, 'processed': 100, 'affected': 100}。"""
        source_meta = target_meta = source_cursor = target_cursor = None
        processed = affected = 0
        committed = False
        try:
            source_columns = self._get_columns(
                source_connection, source_config.get('database', ''), table_name,
            )
            if not source_columns:
                raise ValueError('源库不存在该表或没有可同步列')
            target_columns = self._get_columns(
                target_connection, target_config.get('database', ''), table_name,
            )
            if not target_columns:
                raise ValueError('目标库不存在该表')

            missing = [column for column in source_columns if column not in target_columns]
            if missing:
                preview = ', '.join(missing[:5])
                raise ValueError(f'目标表缺少字段: {preview}')

            mode = table_config.get('mode', 'time')
            time_field = table_config.get('timeField', '')
            if mode != 'all' and time_field and time_field not in source_columns:
                raise ValueError(f'时间字段不存在: {time_field}')

            quoted_table = quote_identifier(table_name)
            quoted_columns = ', '.join(quote_identifier(column) for column in source_columns)
            query, params = self._build_source_query(
                quoted_table, quoted_columns, mode,
                time_field, table_config.get('timeRange', ''),
            )
            placeholders = ', '.join(['%s'] * len(source_columns))
            update_columns = [column for column in source_columns if column.lower() != 'id']
            if update_columns:
                update_clause = ', '.join(
                    f'{quote_identifier(column)} = VALUES({quote_identifier(column)})'
                    for column in update_columns
                )
                upsert_sql = (
                    f'INSERT INTO {quoted_table} ({quoted_columns}) VALUES ({placeholders}) '
                    f'ON DUPLICATE KEY UPDATE {update_clause}'
                )
            else:
                upsert_sql = f'INSERT INTO {quoted_table} ({quoted_columns}) VALUES ({placeholders})'

            # 每张表使用独立源快照和目标事务。
            source_connection.rollback()
            target_connection.rollback()
            source_connection.start_transaction(readonly=True)
            target_connection.start_transaction()
            source_cursor = source_connection.cursor(dictionary=True, buffered=False)
            target_cursor = target_connection.cursor()
            source_cursor.execute(query, params)

            while True:
                rows = source_cursor.fetchmany(SYNC_BATCH_SIZE)
                if not rows:
                    break
                batch = [[row.get(column) for column in source_columns] for row in rows]
                target_cursor.executemany(upsert_sql, batch)
                processed += len(batch)
                affected += max(target_cursor.rowcount, 0)
                yield self._event(
                    f'{table_name} 已处理 {processed} 行', 'info', 'running',
                    table=table_name, processed=processed,
                )

            target_connection.commit()
            committed = True
            source_connection.rollback()
            message = f'{table_name} 完成：读取 {processed} 行，影响 {affected} 行'
            log_service.add(log_service.OK, 'sync', message)
            yield self._event(
                message, 'success', 'running', table=table_name,
                processed=processed, affected=affected,
            )
            return {'ok': True, 'processed': processed, 'affected': affected}
        except Exception as error:
            message = f'{table_name} 失败并已回滚: {error}'
            log_service.add(log_service.ERR, 'sync', message)
            yield self._event(message, 'error', 'running', table=table_name)
            return {'ok': False, 'processed': 0, 'affected': 0}
        finally:
            if not committed:
                try:
                    target_connection.rollback()
                except Exception:
                    pass
            try:
                source_connection.rollback()
            except Exception:
                pass
            close_quietly(source_cursor, target_cursor, source_meta, target_meta)

    @staticmethod
    def _get_columns(connection, database, table):
        """批量查询普通列。@return 例如：['id', 'create_time']。"""
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND IS_GENERATED = 'NEVER' "
                "ORDER BY ORDINAL_POSITION",
                (database, table),
            )
            return [row['COLUMN_NAME'] for row in cursor.fetchall()]
        finally:
            close_quietly(cursor)

    @staticmethod
    def _build_source_query(table, columns, mode, time_field, time_range):
        """构建参数化源查询。@return 例如：('SELECT ... WHERE `time` >= %s', ['2026-08-01'])。"""
        query = f'SELECT {columns} FROM {table}'
        if mode == 'all' or not time_field:
            return query, []
        quoted_time = quote_identifier(time_field)
        if time_range and '~' in time_range:
            start_text, end_text = [part.strip() for part in time_range.split('~', 1)]
            datetime.strptime(start_text, '%Y-%m-%d')
            end_date = datetime.strptime(end_text, '%Y-%m-%d') + timedelta(days=1)
            return (
                f'{query} WHERE {quoted_time} >= %s AND {quoted_time} < %s',
                [start_text, end_date.strftime('%Y-%m-%d')],
            )
        start_text = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
        return f'{query} WHERE {quoted_time} >= %s', [start_text]

    @staticmethod
    def _event(message, level, status, **extra):
        """创建 SSE 事件数据。@return 例如：{'msg': '完成', 'level': 'success'}。"""
        return {'msg': message, 'level': level, 'status': status, **extra}


sync_task = SyncTask()

