# dTools

dTools 是运行在 `127.0.0.1` 上的本地开发工作台，用于查看 AI 编程工具的 Token 用量、在 MySQL 数据库之间同步表数据，以及集中查看运行日志。

正式仓库：[github.com/doraasn/dTools](https://github.com/doraasn/dTools)

## 功能

- **Token 分析**：自动发现并解析 Codex、MimoCode、Claude、OpenCode、Trae CN、Trae 本地记录；支持“全部”跨工具汇总，只有存在有效数据且已启用的来源才显示标签。
- **数据同步**：保存多套源库/目标库连接和表策略，以流式读取、批量 UPSERT、逐表事务方式同步 MySQL 数据。
- **运行日志**：内存保留最近 3000 条事件，按日写入 `~/.dTools/logs`，支持搜索、过滤、复制和持久清空。

Chart.js 已随项目打包，三个模块均可在断网环境使用。

数据库密码以明文保存在当前用户的 `~/.dTools/config.json` 中。这是刻意保留的本地工具设计，请不要把该文件提交到 Git。

## 启动

```powershell
python -m pip install -r requirements.txt
python app.py
```

浏览器访问 [http://127.0.0.1:3456](http://127.0.0.1:3456)，也可以双击 `start.bat`。

## 构建

```powershell
pyinstaller build.spec
```

输出文件为 `dist/dTools.exe`。

## 架构

```text
controller/  Flask 路由、参数校验和 JSON/SSE 响应
service/     配置、日志、Token、数据库元数据业务逻辑
task/        长时间运行的同步调度任务
util/        原子 JSON 存储、数据库连接和标识符工具
constant/    应用、目录、模块与批次常量
templates/   页面结构
static/      设计系统、页面样式和前端逻辑
```

持久化数据继续使用 `~/.dTools`，兼容旧版 `token-settings.json` 和 `sync_config.json` 自动迁移。

Token 设置统一管理全部工具的展示状态、Trae 日志目录以及 Claude 项目别名与显隐。每日趋势悬浮卡片只列出当天有用量的模型，并按用量从低到高排列。界面以 16px 正文、高对比文字和不透明图表为可读性基准。
