"""
线程安全的 JSON 配置存储。

写入时先落到 ~/.dTools/temp，再原子替换正式文件，避免进程中断造成配置损坏。

@author Y77H
@date 2026-08-06
"""

import copy
import json
import os
import tempfile
import threading

from constant.app_constant import CONFIG_FILE, DATA_DIR, TEMP_DIR


_LOCK = threading.RLock()
_LEGACY_FILES = {
    'token': 'token-settings.json',
    'sync': 'sync_config.json',
}


def _ensure_dirs():
    """创建数据和临时目录。@return 例如：None。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)


def load_json(filename, default=None):
    """
    读取 JSON 文件，文件不存在或内容损坏时返回默认值。

    @param filename 例如：config.json
    @param default 例如：{}
    @return 例如：{'token': {}}
    """
    _ensure_dirs()
    filepath = os.path.join(DATA_DIR, filename)
    with _LOCK:
        try:
            with open(filepath, 'r', encoding='utf-8') as file:
                return json.load(file)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return copy.deepcopy(default)


def save_json(filename, data):
    """
    原子保存 JSON 文件。

    @param filename 例如：config.json
    @param data 例如：{'sync': {'configs': {}}}
    @return 例如：None
    """
    _ensure_dirs()
    filepath = os.path.join(DATA_DIR, filename)
    with _LOCK:
        temp_path = ''
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', encoding='utf-8', suffix='.json.tmp',
                prefix='dtools-', dir=TEMP_DIR, delete=False,
            ) as file:
                temp_path = file.name
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, filepath)
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass


def load_config(module_name, default=None):
    """
    读取模块配置，并兼容旧版独立配置文件。

    @param module_name 例如：token
    @param default 例如：{'configs': {}}
    @return 例如：{'trae-intl': 'D:/Trae'}
    """
    with _LOCK:
        all_config = load_json(CONFIG_FILE, {})
        if module_name in all_config:
            return all_config[module_name]

        legacy_file = _LEGACY_FILES.get(module_name)
        if legacy_file:
            legacy_data = load_json(legacy_file, None)
            if legacy_data is not None:
                all_config[module_name] = legacy_data
                save_json(CONFIG_FILE, all_config)
                return legacy_data

        return copy.deepcopy(default if default is not None else {})


def save_config(module_name, data):
    """
    保存指定模块配置，不覆盖其他模块数据。

    @param module_name 例如：sync
    @param data 例如：{'activeConfig': '本地'}
    @return 例如：None
    """
    with _LOCK:
        all_config = load_json(CONFIG_FILE, {})
        all_config[module_name] = data
        save_json(CONFIG_FILE, all_config)
