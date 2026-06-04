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


# ========== 统一配置管理 ==========

CONFIG_FILE = 'config.json'
# 模块名 → 旧文件名映射（用于自动迁移）
_LEGACY_FILES = {
    'token': 'token-settings.json',
    'sync': 'sync_config.json',
}


def _load_all_config():
    """读取完整的 config.json"""
    return load_json(CONFIG_FILE, {})


def _save_all_config(data):
    """保存完整的 config.json"""
    save_json(CONFIG_FILE, data)


def load_config(module_name, default=None):
    """
    从 config.json 中读取指定模块的配置。
    向后兼容：若 config.json 中无该模块数据，自动尝试迁移旧文件。
    @param module_name 模块名（如 'token'、'sync'）
    @param default 默认值
    @return dict
    """
    all_cfg = _load_all_config()
    if module_name in all_cfg:
        return all_cfg[module_name]

    # 向后兼容：尝试读取旧文件并自动迁移
    legacy_file = _LEGACY_FILES.get(module_name)
    if legacy_file:
        legacy_data = load_json(legacy_file, None)
        if legacy_data is not None:
            all_cfg[module_name] = legacy_data
            _save_all_config(all_cfg)
            return legacy_data

    return default if default is not None else {}


def save_config(module_name, data):
    """
    保存指定模块的配置到 config.json。
    @param module_name 模块名（如 'token'、'sync'）
    @param data 要保存的配置数据
    """
    all_cfg = _load_all_config()
    all_cfg[module_name] = data
    _save_all_config(all_cfg)
