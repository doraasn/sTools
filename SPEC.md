# sTools — 全面重写规格说明书

> **目标**: 用 Python + Flask + 前端图表 从零构建 sTools 工具合集
> **参考**: Node.js 版已有完整实现，本规格为精确重写提供所有必要信息
> **构建方式**: PyInstaller `--onefile` 打包成独立 exe

---

## 目录

1. [项目概述](#1-项目概述)
2. [Git 仓库信息](#2-git-仓库信息)
3. [目录结构](#3-目录结构)
4. [核心架构](#4-核心架构)
5. [模块一：Token 看板](#5-模块一token-看板)
6. [模块二：数据同步](#6-模块二数据同步)
7. [主页](#7-主页)
8. [共享主题与通用样式](#8-共享主题与通用样式)
9. [构建与打包](#9-构建与打包)
10. [注意事项](#10-注意事项)

---

## 1. 项目概述

sTools 是一套本地运维工具合集，通过浏览器 Web 界面提供多种功能。所有工具通过主页入口访问，模块化设计方便后续扩展。

**端口**: 3456（绑定 127.0.0.1）

**当前模块**:
| 模块 | 标识 | 功能 |
|------|------|------|
| Token 看板 | `token` | LLM Token 用量统计（Claude Code + Trae） |
| 数据同步 | `sync` | MySQL 数据库间表级数据同步 |
| (预留 SSH 日志) | — | 服务器日志监控（待开发） |

**暗色主题**: 全局使用深色主题，视觉风格统一。Token 看板额外支持亮/暗切换（localStorage 持久化）。

---

## 2. Git 仓库信息

- **远程仓库**: `https://github.com/doraasn/sTools.git`
- **认证方式**: GitHub Personal Access Token (PAT) — 见 `SPEC.secrets.md`（不纳入版本控制）
- **当前分支**: `main`
- **提交历史参考**:
  ```
  ba2d609 feat: redesign home page, add DB type filtering to sync module
  9af4b42 feat: modular hub with home page, merge data-sync tool
  c85eb19 fix: fix garbled Chinese text in start.bat
  7e72233 docs: add README with usage and build instructions
  b0dc042 fix: dedup log events, show cache miss in model bars, fix card height
  95624a9 fix: reorder charts and fix daily bar rendering
  1564d58 fix: rewrite drawDaily function
  94615cc fix: add missing semicolon causing JS syntax error
  28687f8 feat: model total bar chart, cache hit rate, segment order fix
  ad538c3 Token 看板 - initial version
  ```

---

## 3. 目录结构

```
sTools/
  app.py              # 主入口 (Flask app, 模块加载器, 控制台菜单)
  modules/
    __init__.py
    sync.py           # 数据同步模块 (Python)
    sync.html         # 数据同步前端 (复用现有 HTML)
    token.py          # Token 看板模块 (Python)
    common.py         # 共享工具/样式
  static/
    css/
      theme.css       # 全局主题变量
    js/
      chart.js        # 通用图表渲染 (Chart.js 封装)
  templates/
    index.html        # 主页
    token.html        # Token 看板页面
    sync.html         # 数据同步页面 (或直接从 flask 路由 serve sync.html)
  config/
    token-settings.json   # Token 看板设置 (存于 ~/.sTools/token-settings.json)
  build.spec          # PyInstaller 打包配置
requirements.txt      # Python 依赖
start.bat             # 启动脚本
```

### 依赖清单 (requirements.txt)

```
flask>=3.0
mysql-connector-python>=8.0
paramiko>=3.0          # 预留 SSH 日志模块
pyinstaller>=6.0       # 仅构建时需要
```

### 数据文件路径

所有持久化数据存于 `~/.sTools/` 目录：
```
~/.sTools/
  sync_config.json     # 数据同步配置
  token-settings.json  # Token 看板设置 (Trae 路径等)
```

---

## 4. 核心架构

### 4.1 模块加载器

主程序 `app.py` 启动时，扫描 `modules/` 目录下的 `.py` 文件，加载实现了 `Module` 接口的模块：

```python
class Module:
    name: str           # 模块标识，如 'token', 'sync'
    label: str          # 显示名称，如 'Token 看板'
    icon: str           # 图标 emoji，如 '📊'
    description: str    # 描述文本
```

启动时 Flask 自动注册模块提供的蓝图（Blueprint）。

### 4.2 控制台菜单

参考 `server.js` 174-203 行，启动后在控制台显示：

```
  +------------------------------+
  |  sTools  v1.0               |
  |  Token 看板, 数据同步       |
  |                              |
  |  -> http://localhost:3456    |
  |                              |
  |  [S]停止 [R]重启 [O]浏览器  |
  |  [Q]退出                     |
  +------------------------------+
```

快捷键监听: `q` 退出, `s` 停止, `r` 重启, `o` 打开浏览器。使用 `keyboard` 或 `msvcrt` (Windows) 实现非阻塞按键监听。

启动时自动打开浏览器 `http://localhost:3456`。
端口被占用时给出提示。

### 4.3 路由结构

```
/                        → 主页 (serveHome)
/token                   → Token 看板页面
/sync                    → 数据同步页面
/api/tokens              → Token 数据 API
/api/config              → Token 设置 API (GET/POST)
/api/sync/config         → 同步配置 API
/api/sync/configs        → 同步配置列表
/api/sync/config/switch  → 切换配置
/api/sync/config/create  → 新建配置
/api/sync/config/rename  → 重命名配置
/api/sync/db-types       → 数据库类型列表
/api/sync/table-configs  → 表配置列表
/api/sync/table-config/switch  → 切换表配置
/api/sync/table-config/create  → 新建表配置
/api/sync/table-config/rename  → 重命名表配置
/api/sync/test-connection      → 测试数据库连接
/api/sync/tables-all           → 获取所有表及列
/api/sync/table-columns        → 获取指定表列
/api/sync/execute              → 执行同步 (SSE)
```

---

## 5. 模块一：Token 看板

### 5.1 数据源

支持三种数据源：

| 工具 | 类型 | 路径                                       | 文件格式 |
|------|------|--------------------------------------------|----------|
| Claude Code | jsonl | `~/.claude/projects/<project>/*.jsonl`   | JSONL    |
| Trae (国际版) | trae_log | `%APPDATA%\Trae\logs\<session>\Modular\*_stdout.log` | 文本日志 |
| Trae CN | trae_log | `%APPDATA%\Trae CN\logs\<session>\Modular\*_stdout.log` | 文本日志 |

### 5.2 Claude Code JSONL 解析

文件位于 `~/.claude/projects/` 下每个项目目录中，以 `.jsonl` 结尾。每行一个 JSON 对象。

**关键字段**:
```
sessionId: string              # 会话 ID
type: "assistant" | "message"  # 事件类型
timestamp: "2026-01-15T..."    # ISO 时间戳
message.usage: {
  input_tokens: number,
  output_tokens: number,
  cache_read_input_tokens: number,
  cache_creation_input_tokens: number
}
message.model: string          # 模型名，如 "claude-sonnet-4-6"
```

**解析逻辑**:
1. 扫描 `~/.claude/projects/` 下所有子目录，每个目录 = 一个项目
2. 每个项目目录下所有 `.jsonl` 文件逐行解析
3. 只处理 `type === 'assistant'` 或 `type === 'message'` 且有 `usage` 字段的事件
4. **去重**: 连续两条事件的 `input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens` 组合完全相同时跳过（修复 JSONL 中同一事件写两次的 Bug）
5. 每条解析结果：
   ```python
   {
     "date": "2026-01-15",          # timestamp 的前10字符
     "model": "claude-sonnet-4-6",  # model 去除 HTML 标签后 trim
     "project": "project-name",     # 目录名处理: 删除前导 "a--"/"C--" 前缀, "--" 替换为 "/"
     "sessionId": "...",
     "input": int,
     "output": int,
     "cacheRead": int,
     "cacheCreate": int,
     "total": int                   # 四项之和
   }
   ```

**模型名清理**: `cleanModel(raw)` = 去除所有 `<...>` HTML 标签后 trim。
**项目名清理**: `shortName(raw)` = 删除开头的 `[a-zA-Z]--` 前缀和 `Projects--` 前缀，`--` 替换为 `/`。

### 5.3 Trae 日志解析

**文件位置**:
- 默认: `%APPDATA%\Trae\logs\` 或 `%APPDATA%\Trae CN\logs\`
- 可通过设置 API 自定义路径

**目录结构**: `logs/<session>/Modular/ai-agent_*_stdout.log`

**解析方式**:
- 逐行扫描，匹配 `token usage: TokenUsageEvent {` 模式
- TokenUsageEvent 内容跨多行，以 `} trace_id="..." session_id=<id>` 结尾
- 正则提取: `prompt_tokens`, `completion_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- 提取字段值为 `Some(123)` 或裸数字两种格式
- model 固定为 `"Trae"`, project 固定为 `"Trae"`
- 超过 50MB 的日志文件跳过
- 支持同步解析（首次请求）和异步后台解析（启动时预热）

**缓存策略**:
- Claude 数据: 缓存 30 秒，每次请求判断是否过期
- Trae 数据: 独立缓存，同样 30 秒 TTL
- Trae 在启动时通过后台线程预解析

**⚠️ 重要: Trae 日志文件名包含中文字符**，读取时必须使用 UTF-8 编码处理文件系统路径，Windows 下 Python 的 `os.listdir` 默认返回 Unicode 字符串，通常没问题。

### 5.4 数据聚合 API: GET /api/tokens?tool=claude

返回 JSON 结构：

```json
{
  "summary": {
    "grandTotal": 219000000,
    "totalSessions": 42,
    "totalDays": 15,
    "totalModels": 5,
    "totalProjects": 8,
    "totalRecords": 1250
  },
  "models": [
    {
      "name": "claude-sonnet-4-6",
      "total": 100000000,
      "input": 40000000,
      "output": 30000000,
      "cacheRead": 20000000,
      "cacheCreate": 10000000,
      "sessions": 20,
      "share": "45.7"
    }
  ],
  "projects": [
    {
      "name": "my-project",
      "total": 50000000,
      "input": 20000000,
      "output": 15000000,
      "cacheRead": 10000000,
      "cacheCreate": 5000000,
      "sessions": 10,
      "share": "22.8"
    }
  ],
  "cells": [
    {
      "date": "2026-01-15",
      "model": "claude-sonnet-4-6",
      "project": "my-project",
      "input": 1000000,
      "output": 500000,
      "cacheRead": 300000,
      "cacheCreate": 100000,
      "total": 1900000,
      "sessions": 1
    }
  ],
  "modelProject": [
    { "model": "claude-sonnet-4-6", "project": "my-project", "total": 5000000, "sessions": 5 }
  ],
  "dates": ["2026-01-15", "2026-01-16"]
}
```

**数据聚合逻辑**:
1. 所有记录按 `date|model|project` 聚合（key 维度去重）
2. `sessions`: 同一个 `date|model|project` 组内用 Set 去重统计
3. `models`: 按 model 聚合所有记录，计算 share (model.total / grandTotal * 100)
4. `projects`: 按 project 聚合
5. 过滤: 排除 model 为空或 `"unknown"` 的记录，排除 total <= 0 的记录

### 5.5 API: GET /api/config (Token 看板设置)

返回 JSON：
```json
{
  "trae-intl": "C:/Users/xxx/AppData/Roaming/Trae",
  "trae-cn": "C:/Users/xxx/AppData/Roaming/Trae CN"
}
```

### 5.6 API: POST /api/config (Token 看板设置)

请求体：
```json
{
  "trae-intl": "C:/Users/xxx/AppData/Roaming/Trae",
  "trae-cn": "C:/Users/xxx/AppData/Roaming/Trae CN"
}
```

保存后清除 Trae 缓存，下次请求重新解析。

### 5.7 前端 Token 看板

**页面**: `/token` → 为前端单页应用，所有渲染在浏览器端完成。

**依赖**: 使用 Chart.js 替代 node-canvas 服务端渲染。所有图表在浏览器端绘制。

**参考设计**: 见 `modules/token.js` 中 `renderHTML()` (359-1535 行)

**页面布局**:

```
┌────────────────────────────────────────────┐
│  [Claude Code] [Trae] [Trae CN]            │  ← 工具切换 tabs
├────────────────────────────────────────────┤
│  ⚡ Token 看板                [🌙] [⚙]     │  ← header
├────────────────────────────────────────────┤
│  2.1亿 Token  │  15 天  │  5 模型  │  ...  │  ← 统计卡片
├────────────────────────────────────────────┤
│  [全部] [今天] [昨天] [前天] [当月] [日期] │  ← 日期筛选
├────────────────────────────────────────────┤
│  每日 Token 趋势 (堆叠条形图)              │  ← Chart.js stacked bar
│  ■ 输入(缓存未命中) ■ 输入(缓存命中) ■ 输出 │
├────────────────────────────────────────────┤
│  模型 & 项目分布 (双饼图)                  │  ← Chart.js doughnut
│  [模型饼图]      [项目饼图]               │
├────────────────────────────────────────────┤
│  模型 Token 总量 (水平堆叠条)              │  ← Chart.js horizontal bar
└────────────────────────────────────────────┘
```

**关键前端逻辑**:

1. **工具切换**: 点击 `[Claude Code]` / `[Trae]` / `[Trae CN]` 重新拉取 `/api/tokens?tool=xxx`
   - 切换时清空所有筛选状态、隐藏 Set、日期筛选
   - 显示 loading 遮罩，20s 超时
   - 切换后重新开始 5s 轮询

2. **日期筛选**: 6 个预设 + 日历范围选择器
   - `全部`, `今天`, `昨天`, `前天`, `当月`, `[日历选择]`
   - 日历选择器: 独立弹窗组件，支持选择起止日期范围，高亮选中区间
   - 筛选逻辑: 前端过滤 `cells` 数组

3. **模型/项目筛选**: 每个图表下方有图例标签，点击可隐藏/显示对应模型
   - 图例点击切换 Set 状态, 重新渲染对应图表
   - 各图表独立维护隐藏 Set: `chDailyHidden`, `chModelBarHidden`, `chModelHidden`, `chProjectHidden`

4. **Tooltip**: 画布 hover 显示悬浮信息框，显示具体数值和缓存命中率

5. **设置弹窗**:
   - Claude 模式: 项目显隐 checkbox + 显示名称重命名
   - Trae 模式: 日志路径自定义
   - 设置本地持久化 (localStorage: `csd-names`, `csd-hidden`)

6. **主题切换**: localStorage key `csd-theme`, 值 `dark`/`light`
   - HTML 属性 `data-theme` 控制 CSS 变量
   - 切换时所有图表重绘

7. **自动刷新**: 每 5 秒轮询 `/api/tokens?tool=xxx` 更新数据
   - 工具切换过程中不刷新

### 5.8 数字格式化 (前端和后端通用)

```python
def fmt(v):
    if v >= 1e8: return f"{v/1e8:.1f}亿"
    if v >= 1e4: return f"{v/1e4:.1f}万"
    return str(v)
```

### 5.9 Token 看板前端调色板

```javascript
const COLORS = ['#06b6d4','#f59e0b','#10b981','#f43f5e','#8b5cf6',
                '#ec4899','#14b8a6','#e9730f','#6366f1','#84cc16',
                '#d946ef','#22c55e'];
```

### 5.10 颜色处理 (前端工具函数)

```javascript
// 按比例变暗
function darkenColor(hex, f) { ... }
// 按比例变亮（向白色插值）
function lightenColor(hex, f) { ... }
// 缓存命中段 = lightenColor(baseColor, 0.45) → 浅色
// 输出段 = lightenColor(baseColor, 0.2) → 中浅
```

---

## 6. 模块二：数据同步

### 6.1 配置存储

文件: `~/.sTools/sync_config.json`

```json
{
  "configs": {
    "生产同步": {
      "source": { "host": "192.168.1.100", "port": 3306, "user": "root", "password": "xxx", "database": "gas_balance" },
      "target": { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "xxx", "database": "gas_balance_local" },
      "tableConfigs": {
        "默认": {
          "tables": {
            "gas_daily": { "enable": true, "mode": "time", "timeRange": "2026-05-31~2026-06-03", "timeField": "create_time" },
            "gas_station": { "enable": false, "mode": "all", "timeRange": "", "timeField": "" }
          }
        },
        "全量备份": { "tables": { ... } }
      }
    }
  },
  "activeConfig": "生产同步",
  "activeTableConfig": {
    "生产同步": "默认"
  }
}
```

### 6.2 数据库类型体系

```python
DB_TYPES = {
    'mysql': { 'label': 'MySQL', 'defaultPort': 3306, 'icon': '🐬' },
    # 后续扩展: postgresql, sqlserver, oracle
}
```

API: `GET /api/sync/db-types` → 返回 `DB_TYPES`

`connect_db(cfg)`:
1. 根据 `cfg.get('dbType', 'mysql')` 选择驱动
2. MySQL 使用 `mysql.connector.connect()`
3. 对于未知类型抛出 `ValueError('不支持的数据库类型: xxx')`

### 6.3 数据同步实现

**API: POST /api/sync/execute**

SSE (Server-Sent Events) 流式响应。

请求体:
```json
{
  "source": { "host": "...", "port": 3306, "user": "...", "password": "...", "database": "gas_balance" },
  "target": { "host": "...", "port": 3306, "user": "...", "password": "...", "database": "gas_balance_local" },
  "tables": {
    "gas_daily": { "enable": true, "mode": "time", "timeRange": "2026-05-31~2026-06-03", "timeField": "create_time" }
  }
}
```

SSE 事件流格式:
```
data: {"msg": "▶ [gas_daily] 开始同步..."}
data: {"msg": "  ✓ 源库 5000 条 → 新增 4820 更新 180  [3.2s]"}
data: {"msg": ""}
data: {"msg": "━━━━━━━━━━━━━━━━━━━━━━━"}
data: {"msg": "✅ 完成！新增 4820 条，更新 180 条，耗时 3.2s"}
data: {"msg": "__DONE__"}
```

**同步算法** (每条表依次):

1. 查询源库 information_schema.COLUMNS 获取列名（排除 VIRTUAL 生成列）
2. 根据 mode 构建查询:
   - `all` 模式: `SELECT * FROM \`tbl\``
   - `time` 模式: 
     - 有时间范围: `SELECT * FROM \`tbl\` WHERE \`timeField\` >= 'start' AND \`timeField\` < 'end' + INTERVAL 1 DAY`
     - 无时间范围: 默认近 7 天
3. 批量 INSERT ... ON DUPLICATE KEY UPDATE:
   ```sql
   INSERT INTO `tbl` (`col1`, `col2`, ...) VALUES (?, ?, ...)
   ON DUPLICATE KEY UPDATE `col1`=VALUES(`col1`), `col2`=VALUES(`col2`), ...
   ```
   - `id` 列不参与 UPDATE 子句
4. 批次大小 5000 条
5. 新增/更新计数:
   ```python
   # affected = cursor.rowcount (executemany 后)
   upd = max(affected - batch_size, 0)
   ins = max(2 * batch_size - affected, 0)  # 近似值
   ```

**异常处理**:
- 每个表独立 try/catch，某表异常不影响后续表
- 源库表不存在时跳过（查询 columns 返回空）
- 目标库未配置时跳过

**连接管理**:
- 每次同步每个表独立创建连接
- finally 块中确保连接关闭

### 6.4 配置管理 API

所有 API 以 `/api/sync/` 为前缀。

**GET /api/sync/config** — 返回当前激活配置 + 表配置 + 表配置名列表

**POST /api/sync/config** — 保存当前配置
- body: `{ config: { source: {...}, target: {...} }, tableConfig: { tables: {...} } }`

**GET /api/sync/db-types** — 返回支持的数据库类型列表

**GET /api/sync/config/exists** — 判断是否已有配置（用于首次引导建配置）

**GET /api/sync/configs** — 返回所有配置名列表

**POST /api/sync/config/switch** — 切换配置
- body: `{ "name": "配置名" }`
- 返回: 当前激活的完整配置

**POST /api/sync/config/create** — 新建配置
- body: `{ "name": "新配置名" }`
- 自动创建默认表配置

**POST /api/sync/config/rename** — 重命名当前配置
- body: `{ "name": "新名称" }`
- 不允许重名

**GET /api/sync/table-configs** — 返回当前配置的表配置名列表
- query: `?config=配置名`（可选，默认当前配置）

**POST /api/sync/table-config/switch** — 切换表配置
- body: `{ "name": "表配置名" }`
- 返回: `{ "name": "...", "tables": {...} }`

**POST /api/sync/table-config/create** — 新建表配置
- body: `{ "name": "新表配名", "copyFrom": "来源表配名" }`（copyFrom 可选）
- 可复制已有配置

**POST /api/sync/table-config/rename** — 重命名当前表配置
- body: `{ "name": "新名称" }`

### 6.5 数据库操作 API

**POST /api/sync/test-connection** — 测试源/目标连接

请求体: `{ "source": {...}, "target": {...} }`
返回:
```json
{
  "source": { "ok": true, "version": "8.0.35", "tables": 42 },
  "target": { "ok": false, "error": "Can't connect to MySQL server on '127.0.0.1:3306'" }
}
```

检查: 查询 `SELECT VERSION()` 和 `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=?`

**POST /api/sync/tables-all** — 获取指定数据库的所有表及其列

请求体: `{ "host": "...", "port": 3306, "user": "...", "password": "...", "database": "gas_balance" }`
返回:
```json
{
  "tables": ["gas_daily", "gas_station", ...],
  "columns": {
    "gas_daily": [{ "name": "id", "type": "int" }, { "name": "create_time", "type": "datetime" }, ...],
    ...
  }
}
```

查询:
- 表: `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'`
- 列: `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND EXTRA NOT LIKE '%VIRTUAL%'`

**POST /api/sync/table-columns** — 获取指定表的列
请求体: `{ "connection": {...}, "table": "table_name" }`

### 6.6 前端同步页面

**页面**: `/sync` → 复用 `sync.html` 的完整 HTML/CSS/JS

**设计要点**:
- GitHub 风格暗色主题 (bg: #0d1117, surface: #161b22)
- 可折叠面板: 数据库连接 / 表配置 / 运行日志
- 配置选择器 (顶部 bar): 下拉切换 + 重命名 + 新建按钮
- 表配置选择器: 下拉切换 + 重命名 + 新建按钮
- 源/目标数据库连接表单，独立测试连接
- 数据表列表: 搜索过滤、全选、批量设置时间范围
- 时间字段自动检测: 按 `create_time` > `update_time` > `pub_time` > 等关键词匹配日期时间列
- 同步时 SSE 流接收，日志逐条追加显示
- 面板状态 localStorage 持久化 (`sync_tool_panels`)

**⚠️ 关键**: 前端 `sync.html` 中 API 路径硬编码为 `/api/sync/...` 前缀，Flask 后端必须按此路径注册。`/api/sync` (不带后缀) 映射到 execute。

**首次使用流程**:
1. 检测到无配置 → 弹出新建配置弹窗
2. 用户填写源/目标数据库信息 → 测试连接
3. 勾选需要同步的表 → 点击开始同步

### 6.7 同步前端 keydown 监听 (保留功能)

整个页面监听键盘操作：
```
document.addEventListener('keydown', function(e) {
  // 1-9 数字键快速导航
  // 无特定绑定，但有全局 keypress 框架
});
```

---

## 7. 主页

### 7.1 设计

**页面**: `/` → 模块入口卡片网格

**参考实现**: `server.js` 中 `serveHome()` (31-144 行)

**设计规格**:
- 暗色背景 (#0a0a0f)
- 浮动光晕背景动画（3 个模糊圆，CSS animation）
- 标题: "⚡ sTools" + "工具箱 · 效率工具集"
- 键盘快捷键提示: `[1] [2] 在模块内按数字键快速导航 · [Q] 退出`
- 模块卡片网格:
  - 每张卡片渐入动画 (fadeUp)，依次延迟 0.1s
  - hover 时上浮 + 卡片主题色发光 shadow
  - 卡片包含: emoji 图标 (hover 浮动动画) + 标题 + 描述 + 右下箭头
  - 每模块独立主题色: token → cyan (#06b6d4), sync → green (#10b981), 未来模块 → purple (#a855f7)
- 底部: GitHub 链接 · v1.0 · 127.0.0.1:3456

### 7.2 模块注册

每个模块在注册时提供：
```python
{
    "name": "token",
    "label": "Token 看板",
    "icon": "📊",
    "description": "多维度 LLM Token 用量统计：每日趋势、模型/项目分布、缓存命中率"
}
```

主页根据模块列表动态渲染卡片。

---

## 8. 共享主题与通用样式

### 8.1 CSS 变量体系

```css
:root {
  --bg: #0c0a09;      /* 页面背景 */
  --s: #1c1917;       /* 卡片/表面 */
  --s2: #292524;       /* 表面高亮 */
  --b: #44403c;        /* 边框 */
  --t: #e7e5e4;        /* 主文字 */
  --t2: #a8a29e;       /* 辅文字 */
  --a: #06b6d4;        /* 强调色 */
  --r: 8px;            /* 圆角 */
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
}
```

亮色主题覆盖:
```css
[data-theme="light"] {
  --bg: #fafaf9; --s: #fff; --s2: #f5f5f4;
  --b: #d6d3d1; --t: #1c1917; --t2: #78716c; --a: #0891b2;
}
```

Token 看板使用上面的变量体系。
数据同步页面使用独立于 GitHub 风格的变量体系（见 sync.html :root）。

### 8.2 通用组件

**按钮**:
```css
.btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px;
       border: 1px solid var(--b); border-radius: var(--r);
       background: var(--s); color: var(--t); font-size: 13px; cursor: pointer;
       font-family: var(--font); line-height: 1; }
.btn:hover { background: var(--s2); border-color: var(--t2); }
```

**loading 动画**:
```css
.sp { width: 24px; height: 24px; border: 2px solid var(--b);
      border-top-color: var(--a); border-radius: 50%;
      animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

**tooltip**:
```css
.tp { position: fixed; background: #000; color: #fff; font-size: 13px;
      padding: 8px 12px; border-radius: 4px; pointer-events: none;
      z-index: 100; opacity: 0; border: 1px solid #333;
      max-width: 280px; line-height: 1.6; font-family: var(--font); }
.tp.show { opacity: 1; }
```

---

## 9. 构建与打包

### 9.1 PyInstaller 构建

**build.spec** (`--onefile` 模式):

```python
# -*- mode: python ; coding: utf-8 -*-
a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('modules/*.py', 'modules'),
        ('modules/sync.html', 'modules'),
        ('templates/*.html', 'templates'),
    ],
    hiddenimports=['mysql.connector'],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'test', 'unittest', 'email', 'http.server'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=None)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='sTools',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # 控制台模式用于显示 banner + 按键监听
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
```

**依赖**: `pyinstaller>=6.0`, 只构建时需要。

**构建命令**:
```bat
pip install pyinstaller
pyinstaller build.spec
```

**预期输出**: `dist/sTools.exe` (~30-50MB 含 Python 运行时)

### 9.2 启动脚本 (start.bat)

```bat
@echo off
title sTools
start "" http://localhost:3456
python app.py
```

双击 `start.bat` 启动或命令行直接运行。

⚠️ **注意**: `.bat` 文件必须保存为系统编码（Windows 中文版 = GBK），否则中文注释会乱码。

### 9.3 开发模式

```bash
pip install -r requirements.txt
python app.py
```

---

## 10. 注意事项

### 10.1 安全约束

- 服务只绑定 `127.0.0.1`，不允许外部访问
- 数据库密码存本地 JSON 明文（本地工具，不做加密）
- Git 远程 URL 包含 PAT token，推送时自动使用
- 不要触碰任何生产数据库（工具使用方自行负责）

### 10.2 已知问题和边界情况

1. **Trae 日志文件名含中文字符** → `os.listdir` 和 `open()` 需正确处理 Unicode
2. **大文件跳过**: Trae 日志超过 50MB 跳过不解析
3. **JSONL 去重**: Claude Code 日志同一 usage 事件可能写两次，需要通过 `usageKey` 组合检测相邻重复
4. **缓存命中率计算**: `cacheRead / (input + cacheRead)` → 注意 `cacheCreate` 不算"命中"，而是"创建"
5. **数据同步新增/更新计数**: 使用近似公式 `ins = 2*batch - affected`, `upd = affected - batch`，`affected` 为 `cursor.rowcount`
6. **第一次启动无配置**: Token 看板自动使用默认路径，数据同步弹出新建配置引导
7. **Python 的 `mysql.connector` executemany**: Python 版 `cursor.executemany()` 后需 `conn.commit()`；`cursor.rowcount` 在 executemany 后是受影响行数总和
8. **前端本地存储兼容性**: 所有 localStorage 操作包裹 try/catch，防止某些浏览器禁用存储

### 10.3 数据库连接参数

MySQL 连接默认参数:
```python
mysql.connector.connect(
    host=cfg['host'],
    port=int(cfg.get('port', 3306)),
    user=cfg['user'],
    password=cfg['password'],
    database=cfg.get('database', 'gas_balance'),
    charset='utf8mb4'
)
```

### 10.4 information_schema 查询

所有元数据查询都使用 `information_schema`：

列查询（排除 VIRTUAL 生成列）:
```sql
SELECT COLUMN_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
  AND EXTRA NOT LIKE '%VIRTUAL%'
ORDER BY ORDINAL_POSITION
```

表查询:
```sql
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME
```

### 10.5 SSE (Server-Sent Events) 实现

Flask 的 SSE 使用 `Response` + generator:

```python
@app.route('/api/sync/execute', methods=['POST'])
def api_sync():
    data = request.get_json()
    def generate():
        yield f"data: {json.dumps({'msg': '▶ 开始同步...'}, ensure_ascii=False)}\n\n"
        # ... 同步逻辑 ...
        yield f"data: {json.dumps({'msg': '__DONE__'})}\n\n"
    return Response(generate(), mimetype='text/event-stream')
```

前端使用 `fetch` + `ReadableStream`:
```javascript
const resp = await fetch('/api/sync/execute', { method: 'POST', ... });
const reader = resp.body.getReader();
const decoder = new TextDecoder();
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 解析 SSE data: 前缀的行
}
```

### 10.6 模块扩展规范

新模块只需:
1. 在 `modules/` 下新建 `.py` 文件
2. 定义 `Blueprint` 并导出
3. 在 `app.py` 的 `MODULES` 列表中注册

注册格式:
```python
MODULES = [
    {
        'name': 'token', 'label': 'Token 看板', 'icon': '📊',
        'description': '...',
        'blueprint': token_bp,
        'route': '/token',
    },
    # 新模块...
]
```

### 10.7 Python 版与 Node 版关键差异

| 方面 | Node.js 版 | Python 版 |
|------|-----------|-----------|
| Web 框架 | 原生 http 模块 | Flask |
| 图表 | node-canvas 服务端 PNG | Chart.js 浏览器端渲染 |
| MySQL 驱动 | mysql2/promise | mysql-connector-python |
| SSH | ssh2 (未实现) | paramiko (预留) |
| 打包 | SEA (实验性) | PyInstaller (成熟) |
| 路由 | 手动 if/else | Flask Blueprint |
| SSE | res.write() | Response(generator) |
| 模块加载 | require() 动态加载 | Python import + 注册表 |

---

## 附录 A: 当前 Node.js 源码文件列表

| 文件 | 行数 | 功能 |
|------|------|------|
| `server.js` | 262 | 主入口、模块加载器、主页、控制台 |
| `modules/token.js` | 1625 | Token 看板（含完整前端 HTML/CSS/JS） |
| `modules/sync.js` | 490 | 数据同步后端逻辑 |
| `modules/sync.html` | 742 | 数据同步前端页面 |
| `modules/common.js` | 40 | 共享主题 CSS |
| `package.json` | - | 依赖声明 |
| `build_exe.bat` | 74 | SEA 构建脚本 |

## 附录 B: 待开发功能规划

### SSH 日志监控（评估结论）

**可行性**: 完全可行
**核心依赖**: `paramiko` (Python SSH 库)
**实现方案**:
1. 连接管理: paramiko SSHClient，支持密码/key 认证，配置持久化 JSON
2. 日志流式读取: `exec_command('tail -f /path/to/log')` 或 `journalctl -fu unit`
3. Web 推送: 复用 SSE 模式（与 sync 模块相同）
4. 筛选/搜索: 前端关键词过滤、级别筛选
**预估规模**: 400-600 行，核心 200 行
**轻量替代**: 不用实时 tail，改为轮询最后 N 行 + grep 模式

---

*生成日期: 2026-06-04*
*基于 sTools v1.0 Node.js 源码反编译*
