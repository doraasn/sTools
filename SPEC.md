# dTools v3.0 技术说明

更新日期：2026-08-06
仓库：https://github.com/doraasn/dTools

## 1. 产品定位

dTools 是仅绑定 `127.0.0.1:3456` 的个人开发工具。设计优先级依次为：数据操作明确、使用反馈直接、本地配置简单、扩展成本低。

项目不提供账号体系、远程部署和多用户权限。MySQL 密码允许明文写入当前用户目录，这是明确的产品取舍。

## 2. 分层

```text
Controller -> Service -> Task
                 |
              Util / Constant
```

- Controller：路由、请求参数校验、页面渲染、JSON 和 SSE 封装。
- Service：配置管理、日志持久化、Token 解析、数据库元数据业务。
- Task：数据库同步等长时间任务的调度、进度事件与事务边界。
- Util：原子 JSON 写入、数据库连接、标识符安全引用。

## 3. 数据目录

```text
~/.dTools/
  config.json
  logs/YYYY-MM-DD.jsonl
  temp/
```

`config.json` 同时保存 `token` 和 `sync` 两个配置域。写入流程为：临时目录写入、flush、fsync、`os.replace` 原子替换。

## 4. Token 分析

数据源：

- `~/.claude/projects/**/*.jsonl`
- Trae `ai-agent_*_stdout.log`
- `~/.local/share/opencode/opencode.db`
- `~/.local/share/mimocode/mimocode.db`
- `~/.codex/sessions/**/*.jsonl` 与 `~/.codex/archived_sessions/*.jsonl`

后端根据路径、修改时间纳秒和文件大小缓存 JSONL/日志解析结果，并根据数据库与 WAL 状态缓存 OpenCode 兼容数据库。刷新时只重新解析变化的数据源。MimoCode 会排除导入的 Claude/外部会话，避免跨工具重复统计。

工具标签固定为“全部、Codex、MimoCode、Claude、OpenCode、Trae CN、Trae”，无有效数据或在统一设置中关闭展示的来源不生成标签。“全部”并行读取所有已展示来源，并在合并前为会话编号增加工具前缀，避免跨工具会话编号碰撞。Trae 解析同时兼容带/不带 `session_id` 的单行 TokenUsageEvent，并将 `reasoning_tokens` 计入输出与总量。

接口：

- `GET /api/tokens?tool=claude`
- `GET /api/tokens?tool=all`
- `GET /api/token-tools`（仅返回有有效记录的来源）
- `GET /api/token-tool-catalog`（返回固定顺序、数据和展示状态）
- `GET /api/config`
- `POST /api/config`

## 5. 数据同步

同步流程：

1. 在任务开始前同时验证源库和目标库连接。
2. 单个任务复用一对数据库连接，避免按行或按表重复建连。
3. 查询 `information_schema.COLUMNS`，只选择 `IS_GENERATED = 'NEVER'` 的普通列。
4. 验证目标表存在且包含全部源列，验证时间字段来自源表元数据。
5. 使用显式列名和参数化条件查询，以 `fetchmany(1000)` 流式读取。
6. 每张表开启独立目标事务，批量执行 UPSERT；任意异常回滚整张表。
7. SSE 返回每批进度、单表结果和最终成功/失败统计。
8. 全局任务锁阻止重复同步并发写入。

当前使用 MySQL `ON DUPLICATE KEY UPDATE`，要求目标表有正确的主键或唯一键。

## 6. 日志

日志级别为 `info`、`ok`、`warn`、`err`。内存队列上限 3000 条，磁盘保留 7 天。清空接口会同时删除内存内容和 `logs/*.jsonl`。

## 7. 前端设计

- 全局固定导航与粘性顶栏。
- 暗色/亮色主题和紧凑导航由 localStorage 保存。
- 快速日志抽屉可在任意页面打开。
- Token 页面使用指标卡、堆叠趋势和分布图；趋势悬浮卡片自动避让数据柱，仅显示当天有用量的模型，并按用量升序排列。
- Token 设置以单个弹窗统一管理全部工具，可控制工具展示、Trae 日志目录和 Claude 项目别名/显隐。
- Chart.js 固定为 4.4.7 并存放于 `static/chart.umd.min.js`，运行时不依赖 CDN。
- 同步页面使用双库连接卡、表策略工作区和独立任务控制台。
- 所有页面在 920px 以下切换移动导航，在窄屏下保持可操作。

## 8. 本地安全边界

- Flask 只监听 `127.0.0.1`。
- 响应添加 `nosniff`、`DENY` frame 和 `no-referrer`。
- API 不提供鉴权，密码按产品要求明文保存和返回。
- SQL 值使用参数化查询；动态标识符经过长度、空字符检查和反引号转义，并与元数据核对。
- 本工具仍会对目标数据库执行写操作，使用前必须确认连接方案和表策略。

## 9. 路由兼容

v2 的 `/token`、`/sync`、`/log` 以及全部 `/api/tokens`、`/api/config`、`/api/sync/*`、`/api/logs*` 路径保持不变。新增 `GET /api/health`。
