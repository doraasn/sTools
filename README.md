# Token 看板

多维度 LLM Token 使用量统计面板，支持 Claude Code 和 Trae 日志解析。

## 功能

- **每日 Token 趋势**：堆叠条形图展示每日各模型的 input/cache/output 分布，支持悬浮查看详情
- **模型 & 项目分布**：饼图展示各模型/项目的 Token 占比
- **模型 Token 总量**：水平条形图对比各模型总量，含缓存命中率
- **交互筛选**：按模型/项目过滤，日期范围选择
- **工具切换**：支持 Claude Code / Trae 多数据源

## 快速开始

```bash
node server.js
```

或双击 `start.bat`，访问 http://localhost:3456

## 数据来源

| 数据源 | 路径 |
|---|---|
| Claude Code | `~/.claude/projects/*/.jsonl` |
| Trae (国际版) | `%APPDATA%/Trae/logs/` |
| Trae (中国版) | `%APPDATA%/Trae CN/logs/` |

## 构建单文件 exe

```bash
build_exe.bat
```

输出 `Token 看板.exe`，无需 Node.js 环境即可运行。

## 技术栈

- Node.js (纯 http 模块，无框架)
- Canvas 2D 渲染
- SEA (Single Executable Application) 打包
