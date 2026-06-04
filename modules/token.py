"""
dTools Token 看板模块
Claude Code + Trae 的 LLM Token 用量统计
@author y77h 2026-06-04
"""

import json
import os
import re
import threading
import time

from flask import Blueprint, jsonify, render_template, request

from modules.common import load_json, save_json
from modules import log_collector

# 模块元数据
MODULE_INFO = {
    'name': 'token',
    'label': 'Token 看板',
    'icon': '◈',
    'description': 'LLM Token 用量统计与趋势分析',
    'accent': '#06b6d4',
}

token_bp = Blueprint('token', __name__)

# 工具配置
TOOL_CONFIGS = {
    'claude': {
        'dir': os.path.join(os.path.expanduser('~'), '.claude', 'projects'),
        'type': 'jsonl',
        'label': 'Claude Code',
    },
    'trae-intl': {
        'dirs': [os.path.join(os.environ.get('APPDATA', ''), 'Trae')],
        'type': 'trae_log',
        'label': 'Trae',
    },
    'trae-cn': {
        'dirs': [os.path.join(os.environ.get('APPDATA', ''), 'Trae CN')],
        'type': 'trae_log',
        'label': 'Trae CN',
    },
}

# 缓存
CACHE_TTL = 30
_cache = {'data': None, 'ts': 0}
# Trae 缓存：None = 未解析, [] = 已解析但无数据
_trae_caches = {}
_trae_parsing = {}

CONFIG_FILE = 'token-settings.json'

# 正则
CLEAN_MODEL_RE = re.compile(r'<[^>]*>')
SHORT_PREFIX_RE = re.compile(r'^[a-zA-Z]--')
SHORT_PROJECTS_RE = re.compile(r'^Projects--')


def short_name(raw):
    """清理项目名"""
    s = SHORT_PREFIX_RE.sub('', raw)
    s = SHORT_PROJECTS_RE.sub('', s)
    s = s.replace('--', '/')
    return s if s else raw


def clean_model(raw):
    """清理模型名"""
    return CLEAN_MODEL_RE.sub('', str(raw or '')).strip()


def get_config():
    """读取设置"""
    return load_json(CONFIG_FILE, {})


def save_config(data):
    """保存设置"""
    save_json(CONFIG_FILE, data)


# ========== Claude Code JSONL 解析 ==========

def parse_all(tool_name=None):
    """解析 Claude Code JSONL 文件"""
    global _cache
    if tool_name is None:
        tool_name = 'claude'

    cfg = TOOL_CONFIGS.get(tool_name)
    if not cfg or cfg.get('type') != 'jsonl':
        return []

    now = time.time()
    if _cache['data'] is not None and now - _cache['ts'] < CACHE_TTL:
        return _cache['data']

    base_dir = cfg.get('dir', '')
    if not os.path.isdir(base_dir):
        _cache = {'data': [], 'ts': time.time()}
        return []

    log_collector.add(log_collector.INFO, 'token', '开始解析 Claude Code JSONL...')
    records = []
    try:
        for proj in os.listdir(base_dir):
            proj_dir = os.path.join(base_dir, proj)
            if not os.path.isdir(proj_dir):
                continue
            for fname in os.listdir(proj_dir):
                if fname.endswith('.jsonl'):
                    records.extend(_parse_jsonl_file(os.path.join(proj_dir, fname), proj))
    except Exception as e:
        log_collector.add(log_collector.ERR, 'token', f'解析 JSONL 失败: {e}')

    _cache = {'data': records, 'ts': time.time()}
    log_collector.add(log_collector.OK, 'token', f'Claude Code 解析完成: {len(records)} 条记录')
    return records


def _parse_jsonl_file(filepath, proj):
    """解析单个 JSONL 文件"""
    records = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.read().strip().split('\n')
    except Exception:
        return records

    session_id = ''
    last_usage_key = ''

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue

        if e.get('sessionId'):
            session_id = e['sessionId']
            last_usage_key = ''

        model = None
        usage = None

        if e.get('type') in ('assistant', 'message'):
            msg = e.get('message', {})
            if msg and msg.get('usage') and e.get('timestamp'):
                model = clean_model(msg.get('model', ''))
                usage = msg['usage']
            elif e.get('usage') and not (msg and msg.get('usage')):
                model = clean_model(e.get('model', ''))
                usage = e['usage']

        if not usage or not e.get('timestamp'):
            continue

        usage_key = '|'.join(str(usage.get(k, 0)) for k in
                            ['input_tokens', 'output_tokens',
                             'cache_read_input_tokens', 'cache_creation_input_tokens'])
        if usage_key == last_usage_key:
            continue
        last_usage_key = usage_key

        inp = usage.get('input_tokens', 0) or 0
        out = usage.get('output_tokens', 0) or 0
        cr = usage.get('cache_read_input_tokens', 0) or 0
        cc = usage.get('cache_creation_input_tokens', 0) or 0

        records.append({
            'date': str(e['timestamp'])[:10],
            'model': model or 'unknown',
            'project': short_name(proj),
            'sessionId': session_id,
            'input': inp, 'output': out,
            'cacheRead': cr, 'cacheCreate': cc,
            'total': inp + out + cr + cc,
        })

    return records


# ========== Trae 日志解析 ==========

TRAE_START_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*token usage:\s*TokenUsageEvent\s*\{'
)
TRAE_END_RE = re.compile(r'\}\s*trace_id="[^"]*"\s*session_id=(\w+)')


def _parse_trae_log_file(filepath):
    """解析单个 Trae 日志文件"""
    records = []
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
    except Exception:
        return records

    buf, cur_ts, in_event = '', '', False

    for line in lines:
        line = line.rstrip('\n').rstrip('\r')
        m = TRAE_START_RE.match(line)
        if m:
            end_m = TRAE_END_RE.search(line)
            if end_m:
                _add_trae_record(records, line[m.end():end_m.start()], m.group(1), end_m.group(1))
                in_event = False
                continue
            buf = line[m.end():]
            cur_ts = m.group(1)
            in_event = True
            continue

        if in_event:
            end_m = TRAE_END_RE.search(line)
            if end_m:
                _add_trae_record(records, buf + '\n' + line[:end_m.start()], cur_ts, end_m.group(1))
                in_event = False
                buf = ''
            else:
                buf += '\n' + line

    return records


def _add_trae_record(records, body, timestamp, session_id):
    """从 TokenUsageEvent body 提取 token 数据"""
    def gf(name):
        m = re.search(rf'{name}:\s*(?:Some\((\d+)\)|(\d+))', body)
        if m:
            return int(m.group(1) if m.group(1) is not None else m.group(2))
        return 0

    inp = gf('prompt_tokens')
    out = gf('completion_tokens')
    cr = gf('cache_read_input_tokens')
    cc = gf('cache_creation_input_tokens')

    records.append({
        'date': timestamp[:10],
        'model': 'Trae', 'project': 'Trae',
        'sessionId': session_id,
        'input': inp, 'output': out,
        'cacheRead': cr, 'cacheCreate': cc,
        'total': inp + out + cr + cc,
    })


def parse_trae_logs(tool):
    """解析 Trae 日志目录"""
    cfg = TOOL_CONFIGS.get(tool)
    if not cfg or cfg.get('type') != 'trae_log':
        return []

    log_collector.add(log_collector.INFO, 'token', f'开始解析 {cfg.get("label", tool)} 日志...')

    server_cfg = get_config()
    if tool == 'trae-intl' and server_cfg.get('trae-intl'):
        dirs = [server_cfg['trae-intl']]
    elif tool == 'trae-cn' and server_cfg.get('trae-cn'):
        dirs = [server_cfg['trae-cn']]
    else:
        dirs = cfg.get('dirs', [])

    records = []
    for base_dir in dirs:
        if not base_dir:
            continue
        logs_dir = base_dir
        if os.path.basename(base_dir) != 'logs':
            logs_dir = os.path.join(base_dir, 'logs')
        if not os.path.isdir(logs_dir):
            continue

        try:
            for session_dir in os.listdir(logs_dir):
                mod_dir = os.path.join(logs_dir, session_dir, 'Modular')
                if not os.path.isdir(mod_dir):
                    continue
                for fname in os.listdir(mod_dir):
                    if fname.endswith('_stdout.log') and fname.startswith('ai-agent_'):
                        fp = os.path.join(mod_dir, fname)
                        try:
                            if os.path.getsize(fp) > 50 * 1024 * 1024:
                                continue
                        except OSError:
                            continue
                        records.extend(_parse_trae_log_file(fp))
        except Exception:
            continue

    log_collector.add(log_collector.OK, 'token', f'{cfg.get("label", tool)} 解析完成: {len(records)} 条记录')
    return records


def _parse_trae_async(tool):
    """后台异步解析 Trae 日志"""
    if tool in _trae_parsing:
        return _trae_parsing[tool]

    event = threading.Event()
    _trae_parsing[tool] = event

    def _do_parse():
        try:
            records = parse_trae_logs(tool)
            _trae_caches[tool] = {'data': records, 'ts': time.time()}
        except Exception:
            _trae_caches[tool] = {'data': [], 'ts': time.time()}
        finally:
            event.set()
            _trae_parsing.pop(tool, None)

    threading.Thread(target=_do_parse, daemon=True).start()
    return event


def _get_trae_data(tool):
    """获取 Trae 数据（带缓存）"""
    cache = _trae_caches.get(tool)

    # None = 从未解析过
    if cache is None:
        if tool in _trae_parsing:
            _trae_parsing[tool].wait(timeout=30)
            cache = _trae_caches.get(tool)
        else:
            records = parse_trae_logs(tool)
            _trae_caches[tool] = {'data': records, 'ts': time.time()}
            cache = _trae_caches[tool]
    elif time.time() - cache['ts'] > CACHE_TTL:
        _parse_trae_async(tool)

    return cache.get('data', []) if cache else []


def _preheat_trae():
    """启动时后台预解析"""
    for tool, cfg in TOOL_CONFIGS.items():
        if cfg.get('type') == 'trae_log':
            _parse_trae_async(tool)


# ========== 数据聚合 ==========

def get_token_report(records):
    """将原始记录聚合为报告结构"""
    filtered = [r for r in records
                if r.get('model') and r['model'] != 'unknown' and r.get('total', 0) > 0]

    cell_map = {}
    model_totals = {}
    proj_totals = {}
    grand_total = 0
    all_sessions = set()
    all_dates = set()

    for r in filtered:
        d, m, p = r['date'], r['model'], r['project']
        sid = r.get('sessionId', '')

        ck = f"{d}|{m}|{p}"
        if ck not in cell_map:
            cell_map[ck] = {
                'date': d, 'model': m, 'project': p,
                'input': 0, 'output': 0, 'cacheRead': 0, 'cacheCreate': 0,
                'total': 0, 'sessions': set(),
            }
        c = cell_map[ck]
        c['input'] += r['input']
        c['output'] += r['output']
        c['cacheRead'] += r['cacheRead']
        c['cacheCreate'] += r['cacheCreate']
        c['total'] += r['total']
        if sid:
            c['sessions'].add(sid)

        if m not in model_totals:
            model_totals[m] = {
                'name': m, 'total': 0, 'input': 0, 'output': 0,
                'cacheRead': 0, 'cacheCreate': 0, 'sessions': set(),
            }
        mt = model_totals[m]
        mt['total'] += r['total']
        mt['input'] += r['input']
        mt['output'] += r['output']
        mt['cacheRead'] += r['cacheRead']
        mt['cacheCreate'] += r['cacheCreate']
        if sid:
            mt['sessions'].add(sid)

        if p not in proj_totals:
            proj_totals[p] = {
                'name': p, 'total': 0, 'input': 0, 'output': 0,
                'cacheRead': 0, 'cacheCreate': 0, 'sessions': set(),
            }
        pt = proj_totals[p]
        pt['total'] += r['total']
        pt['input'] += r['input']
        pt['output'] += r['output']
        pt['cacheRead'] += r['cacheRead']
        pt['cacheCreate'] += r['cacheCreate']
        if sid:
            pt['sessions'].add(sid)

        grand_total += r['total']
        if sid:
            all_sessions.add(sid)
        all_dates.add(d)

    cells = []
    for c in cell_map.values():
        cells.append({
            'date': c['date'], 'model': c['model'], 'project': c['project'],
            'input': c['input'], 'output': c['output'],
            'cacheRead': c['cacheRead'], 'cacheCreate': c['cacheCreate'],
            'total': c['total'], 'sessions': len(c['sessions']),
        })
    cells.sort(key=lambda x: x['date'])

    models = []
    for mt in model_totals.values():
        share = f"{mt['total'] / grand_total * 100:.1f}" if grand_total > 0 else '0.0'
        models.append({
            'name': mt['name'], 'total': mt['total'],
            'input': mt['input'], 'output': mt['output'],
            'cacheRead': mt['cacheRead'], 'cacheCreate': mt['cacheCreate'],
            'sessions': len(mt['sessions']), 'share': share,
        })
    models.sort(key=lambda x: x['name'])

    projects = []
    for pt in proj_totals.values():
        share = f"{pt['total'] / grand_total * 100:.1f}" if grand_total > 0 else '0.0'
        projects.append({
            'name': pt['name'], 'total': pt['total'],
            'input': pt['input'], 'output': pt['output'],
            'cacheRead': pt['cacheRead'], 'cacheCreate': pt['cacheCreate'],
            'sessions': len(pt['sessions']), 'share': share,
        })
    projects.sort(key=lambda x: x['name'])

    return {
        'summary': {
            'grandTotal': grand_total,
            'totalSessions': len(all_sessions),
            'totalDays': len(all_dates),
            'totalModels': len(model_totals),
            'totalProjects': len(proj_totals),
            'totalRecords': len(filtered),
        },
        'models': models,
        'projects': projects,
        'cells': cells,
    }


# ========== 路由 ==========

@token_bp.route('/token')
def token_page():
    return render_template('token.html')


@token_bp.route('/api/tokens')
def api_tokens():
    tool = request.args.get('tool', 'claude')
    if tool not in TOOL_CONFIGS:
        return jsonify({'error': f'未知工具: {tool}'}), 400

    cfg = TOOL_CONFIGS[tool]
    if cfg.get('type') == 'jsonl':
        records = parse_all(tool)
    else:
        records = _get_trae_data(tool)

    return jsonify(get_token_report(records))


@token_bp.route('/api/config', methods=['GET'])
def api_config_get():
    return jsonify(get_config())


@token_bp.route('/api/config', methods=['POST'])
def api_config_post():
    try:
        data = request.get_json()
        if not data or not isinstance(data, dict):
            return jsonify({'error': '无效的请求数据'}), 400
        save_config(data)
        log_collector.add(log_collector.INFO, 'token', 'Token 看板设置已保存')
        for tool in ('trae-intl', 'trae-cn'):
            _trae_caches.pop(tool, None)
            _trae_parsing.pop(tool, None)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def register(app):
    app.register_blueprint(token_bp)
    _preheat_trae()
