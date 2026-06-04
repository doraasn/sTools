"""
dTools 共享工具模块
提供数字格式化、JSON 读写、数据目录管理等通用功能
@author y77h 2026-06-04
"""

import json
import os

# 数据文件根目录
DATA_DIR = os.path.join(os.path.expanduser('~'), '.dTools')


def get_data_dir():
    """获取数据目录路径，不存在则创建"""
    os.makedirs(DATA_DIR, exist_ok=True)
    return DATA_DIR


def fmt(v):
    """数字格式化：>=1亿 显示 X.X亿，>=1万 显示 X.X万"""
    if v >= 1e8:
        return f"{v / 1e8:.1f}亿"
    if v >= 1e4:
        return f"{v / 1e4:.1f}万"
    return str(int(v))


def load_json(filename, default=None):
    """从数据目录读取 JSON 文件，失败返回 default"""
    filepath = os.path.join(get_data_dir(), filename)
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(filename, data):
    """将数据写入数据目录的 JSON 文件"""
    filepath = os.path.join(get_data_dir(), filename)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
