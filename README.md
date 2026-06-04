# dTools

开发工具集，通过浏览器 Web 界面提供多种本地开发辅助功能。

## 模块

| 模块 | 功能 |
|------|------|
| Token 看板 | LLM Token 用量统计：每日趋势、模型/项目分布、缓存命中率 |
| 数据同步 | MySQL 表级数据同步：配置管理、连接测试、批量 UPSERT |
| 日志 | 统一日志查看：实时流、搜索过滤、关键词高亮 |

## 快速开始

```bash
pip install -r requirements.txt
python app.py
```

或双击 `start.bat`，访问 http://127.0.0.1:3456

## 构建单文件 exe

```bash
pip install pyinstaller
pyinstaller build.spec
```

输出 `dist/dTools.exe`，无需 Python 环境即可运行。

## 技术栈

- Python + Flask
- Chart.js (浏览器端图表渲染)
- mysql-connector-python
- PyInstaller 打包
