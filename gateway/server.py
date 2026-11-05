# -*- coding: utf-8 -*-
"""
English Study 本地网关（纯本地版，可公开发布）
- 语境解释 / 整句翻译：可选。配置 ES_API(OpenAI 兼容端点) + ES_KEY 才启用；
  不配置就只用本地词典，绝不向任何服务器发请求。
- 查词记录（每天搜过哪些词）
- 生词本 + SM-2 间隔复习
- 沉浸时长统计 / 看板 / CSV 导出
- 纯标准库，无第三方依赖。默认监听 0.0.0.0:8788
- 所有学习数据只写本机 SQLite（data/english-study.db），没有云同步。
"""
import json, os, re, sys, glob, shutil, subprocess, sqlite3, time, hashlib, threading, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, 'web')
DATA = os.path.join(BASE, '..', 'data')
os.makedirs(DATA, exist_ok=True)
DB = os.path.join(DATA, 'english-study.db')
PORT = int(os.environ.get('ES_PORT', '8788'))
# 0.0.0.0 = 允许手机（同一 Wi-Fi）访问；只想本机用就设 ES_HOST=127.0.0.1
HOST = os.environ.get('ES_HOST', '0.0.0.0')
TZ = timezone(timedelta(hours=8))
# AI 是可选的：把 ES_API 指向任意 OpenAI 兼容的 /chat/completions 端点，
# 再把密钥放进 ES_KEY（或 DEEPSEEK_API_KEY）。两者缺一 -> 纯本地词典模式。
MODEL = os.environ.get('ES_MODEL', '')
API = os.environ.get('ES_API', '')
KEY = ''

def ai_ready():
    """只有同时配了端点和密钥才算启用 AI；否则一律走本地词典。"""
    return bool(API and KEY and API.lower().startswith(('http://', 'https://')))

lock = threading.Lock()

def now_ts():
    return int(time.time())

def today():
    return datetime.now(TZ).strftime('%Y-%m-%d')

def day_of(ts):
    return datetime.fromtimestamp(ts, TZ).strftime('%Y-%m-%d')

def load_key():
    # 密钥只从环境变量读，不读任何配置文件、不落盘、不进日志。
    return (os.environ.get('ES_KEY') or os.environ.get('DEEPSEEK_API_KEY') or '').strip()

KEY = load_key()

def db():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    c = db()
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''
    CREATE TABLE IF NOT EXISTS lookups(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL, ts INTEGER NOT NULL,
      word TEXT NOT NULL, lemma TEXT, sentence TEXT, url TEXT, video TEXT,
      cached INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_lookups_day ON lookups(day);
    CREATE INDEX IF NOT EXISTS idx_lookups_word ON lookups(word);

    CREATE TABLE IF NOT EXISTS words(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lemma TEXT UNIQUE NOT NULL, word TEXT, phonetic TEXT, meaning TEXT,
      in_context TEXT, collocations TEXT, example TEXT, cefr TEXT, note TEXT,
      sentence TEXT, url TEXT, video TEXT,
      created INTEGER, status TEXT DEFAULT 'learning',
      ease REAL DEFAULT 2.5, interval INTEGER DEFAULT 0, due INTEGER,
      reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, last INTEGER);

    CREATE TABLE IF NOT EXISTS immersion(
      day TEXT PRIMARY KEY, seconds INTEGER DEFAULT 0, updated INTEGER);

    CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, v TEXT, ts INTEGER);

    CREATE TABLE IF NOT EXISTS sentences(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, ts INTEGER, text TEXT, translation TEXT, note TEXT,
      url TEXT, video TEXT);

    CREATE TABLE IF NOT EXISTS reviews(
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, ts INTEGER,
      word_id INTEGER, lemma TEXT, grade TEXT);

    CREATE TABLE IF NOT EXISTS dictation(
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, ts INTEGER,
      kind TEXT, ref_id INTEGER, text TEXT, input TEXT,
      correct INTEGER, score REAL);

    CREATE TABLE IF NOT EXISTS usage(
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, ts INTEGER,
      kind TEXT, model TEXT, in_tok INTEGER, out_tok INTEGER);
    ''')
    cols = [r[1] for r in c.execute('PRAGMA table_info(words)').fetchall()]
    if 'morphology' not in cols:
        c.execute('ALTER TABLE words ADD COLUMN morphology TEXT')
    c.commit()
    c.close()

init_db()

# ---------------- 可选 AI（OpenAI 兼容端点） ----------------

def call_llm(messages, max_tokens=700, temperature=0.2, json_mode=False):
    if not ai_ready():
        raise RuntimeError('NO_AI')
    body = json.dumps({
        'model': MODEL, 'messages': messages,
        'max_tokens': max_tokens, 'temperature': temperature,
        'response_format': {'type': 'json_object'},
    }).encode('utf-8')
    req = urllib.request.Request(API, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
    })
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8'))
            return d['choices'][0]['message']['content'], d.get('usage', {})
        except urllib.error.HTTPError as e:
            code = e.code
            body_txt = (e.read() or b'')[:200].decode('utf-8', 'ignore')
            last = urllib.error.HTTPError(e.url, code, '%s %s' % (e.reason, body_txt), e.headers, None)
            if code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise last
        except urllib.error.URLError as e:
            last = e
            if attempt < 2:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise
    if last:
        raise last

EXPLAIN_SYS = (
    '你是英语精读老师，服务中文母语的高中生。只输出 JSON 对象，不要 markdown、不要解释。'
    '字段：lemma(原形/词根形式), phonetic(英式 IPA, 带斜杠), meaning_zh(结合原句的中文释义), '
    'in_context(为什么在这句里是这个意思，1-2 句中文), collocations(2-3 个常用搭配，中文提示), '
    'cefr(A1-C2 难度), example(一个同难度英文例句，附中文翻译), note(易混点或语感提示，可空字符串), '
    'morphology(词根词缀拆解：形如 "前缀 re-(again) + 词根 -sil-(跳) + 后缀 -ient(形容词)"，'
    '再给 3 个同词族单词及中文义，用中文说明，一段字符串，可空)'
)

def parse_json_obj(txt):
    txt = (txt or '').strip()
    txt = re.sub(r'^```(?:json)?', '', txt).strip()
    txt = re.sub(r'```$', '', txt).strip()
    try:
        return json.loads(txt)
    except Exception:
        m = re.search(r'\{.*\}', txt, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None

def cache_get(k):
    c = db()
    row = c.execute('SELECT v FROM cache WHERE k=?', (k,)).fetchone()
    c.close()
    return json.loads(row['v']) if row else None

def cache_put(k, v):
    c = db()
    c.execute('INSERT OR REPLACE INTO cache(k,v,ts) VALUES(?,?,?)', (k, json.dumps(v, ensure_ascii=False), now_ts()))
    c.commit()
    c.close()

def record_usage(kind, usage):
    if not usage:
        return
    try:
        c = db()
        c.execute('INSERT INTO usage(day,ts,kind,model,in_tok,out_tok) VALUES(?,?,?,?,?,?)',
                  (today(), now_ts(), kind, MODEL, usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0)))
        c.commit()
        c.close()
    except Exception:
        pass

def usage_stats():
    c = db()
    t = c.execute('SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o FROM usage WHERE day=?', (today(),)).fetchone()
    a = c.execute('SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o FROM usage').fetchone()
    c.close()
    # 粗略估价：按输入 $0.15/M、输出 $0.6/M、汇率 ¥7.1/$ 折算，仅供参考
    def cost(i, o):
        return round((i * 0.15 + o * 0.6) / 1000000 * 7.1, 3)
    return {
        'today': {'calls': t['n'], 'in': t['i'], 'out': t['o'], 'cost_cny': cost(t['i'], t['o'])},
        'total': {'calls': a['n'], 'in': a['i'], 'out': a['o'], 'cost_cny': cost(a['i'], a['o'])},
    }

def log_lookup(word, lemma, sentence, url, video, cached):
    """记录一次查词；同一词 60 秒内重复点击只记一次（避免刷屏）。"""
    if not word:
        return
    c = db()
    try:
        row = c.execute('SELECT ts FROM lookups WHERE word=? ORDER BY id DESC LIMIT 1', (word,)).fetchone()
        if row and now_ts() - (row['ts'] or 0) < 60:
            return
        c.execute('INSERT INTO lookups(day,ts,word,lemma,sentence,url,video,cached) VALUES(?,?,?,?,?,?,?,?)',
                  (today(), now_ts(), word, lemma or word, sentence or '', url or '', video or '', 1 if cached else 0))
        c.commit()
    finally:
        c.close()

def lookup_log(body):
    log_lookup((body.get('word') or '')[:60], (body.get('lemma') or '')[:80],
               (body.get('sentence') or '')[:600], (body.get('url') or '')[:500],
               (body.get('video') or '')[:200], bool(body.get('cached')))
    return {'ok': True}

def local_explain(word, sentence, url, video):
    """没配置 AI 时的降级路径：只查本地词典，不发起任何网络请求。"""
    d = dict_lookup(word)
    found = bool(d.get('found'))
    lemma = ((d.get('word') if found else word) or word).strip().lower()
    meaning = ((d.get('translation') or '').strip() if found else '')
    out = {
        'word': word,
        'lemma': lemma,
        'phonetic': (d.get('phonetic') or '') if found else '',
        'meaning': meaning or ('本地词典没收录「%s」。想要上下文解释，自己配 ES_API/ES_KEY。' % word),
        'in_context': '',
        'collocations': '',
        'cefr': '',
        'example': (d.get('definition') or '').strip() if found else '',
        'note': '本地词典模式：未配置 AI，本次查词没有调用任何外部接口。',
        'morphology': '',
        'sentence': sentence,
        'saved': False,
        'ts': now_ts(),
        'local_only': True,
        'source': d.get('source') or '',
        'usage': {},
    }
    log_lookup(word, lemma, sentence, url, video, False)
    return out


def explain(body):
    word = (body.get('word') or '').strip()[:60]
    sentence = (body.get('sentence') or '').strip()[:600]
    url = (body.get('url') or '')[:400]
    video = (body.get('video') or '')[:200]
    if not word:
        raise ValueError('empty word')
    ck = 'ex:' + hashlib.sha1((word.lower() + '|' + sentence).encode('utf-8')).hexdigest()[:20]
    cached = None if body.get('force') else cache_get(ck)
    if cached is not None and 'morphology' not in cached:
        cached = None  # 老版本缓存没有词根字段，重新问一次
    if cached:
        log_lookup(word, cached.get('lemma'), sentence, url, video, True)
        cached['cached'] = True
        return cached
    if not ai_ready():
        return local_explain(word, sentence, url, video)
    user = f'目标词：{word}\n原句：{sentence or "（无上下文，仅单词）"}\n学习者的母语：中文。'
    txt, usage = call_llm([
        {'role': 'system', 'content': EXPLAIN_SYS},
        {'role': 'user', 'content': user},
    ])
    record_usage('explain', usage)
    obj = parse_json_obj(txt) or {}
    out = {
        'word': word,
        'lemma': (obj.get('lemma') or word).strip().lower(),
        'phonetic': obj.get('phonetic') or '',
        'meaning': obj.get('meaning_zh') or '',
        'in_context': obj.get('in_context') or '',
        'collocations': obj.get('collocations') or '',
        'cefr': obj.get('cefr') or '',
        'example': obj.get('example') or '',
        'note': obj.get('note') or '',
        'morphology': obj.get('morphology') or '',
        'sentence': sentence,
        'saved': False,
        'ts': now_ts(),
        'usage': usage,
    }
    cache_put(ck, {k: v for k, v in out.items() if k != 'usage'})
    log_lookup(word, out['lemma'], sentence, url, video, False)
    return out

# ---------------- YouTube 浏览（InnerTube：首页 feed / 搜索 / 缩略图） ----------------
# 只用官方公开的 youtubei 接口，不抓 watch 页 HTML；视频仍然由面板里的官方 /embed/ 播放器在线播。
# InnerTube 需要一个 key。为了不把任何 key 写进仓库，这里只从环境变量读取：
#   set YT_INNERTUBE_KEY=<你从 YouTube 网页端拿到的公开 web client key>
# 未设置时浏览功能整体关闭（搜索/字幕/播放仍然可用），不会连带影响其它接口。
YT_IK = os.environ.get('YT_INNERTUBE_KEY', '').strip()
YT_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
YT_THUMB_DIR = os.path.join(DATA, 'yt-thumbs')
YT_TOPICS = ['technology', 'science', 'english learning', 'documentary', 'music',
             'news', 'history', 'space', 'computer science', 'programming',
             'psychology', 'economics', 'philosophy', 'movie review', 'cooking',
             'travel', 'fitness', 'art', 'photography', 'gaming', 'math',
             'physics', 'chemistry', 'biology', 'engineering', 'design']
# 登录态只放内存：cookie 值绝不落盘、绝不进日志
_YT_SESSION = {'header': '', 'at': 0, 'source': ''}
_YT_MEM = {}
_YT_MEM_TTL = 90


def _yt_open(url, data=None, headers=None, timeout=25):
    h = {'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9'}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    px = _yt_proxy()
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': px, 'https': px})) if px else urllib.request.build_opener()
    return op.open(req, timeout=timeout)


def _yt_ctx():
    c = {'client': {'clientName': 'WEB', 'clientVersion': '2.20240101.00.00',
                    'hl': 'en', 'gl': 'US'}}
    return {'client': c['client']}


def _innertube(path, body):
    if not YT_IK:
        raise RuntimeError('YT_INNERTUBE_KEY 未配置：YouTube 浏览功能已关闭（搜索/字幕/播放不受影响）')
    h = {'Content-Type': 'application/json',
         'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20240101.00.00'}
    if _YT_SESSION['header']:
        h['Cookie'] = _YT_SESSION['header']
    with _yt_open('https://www.youtube.com/youtubei/v1/%s?key=%s' % (path, YT_IK),
                  data=json.dumps(body).encode(), headers=h) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def _yt_pick(node, out):
    if isinstance(node, dict):
        v = node.get('videoRenderer')
        if isinstance(v, dict):
            vid = v.get('videoId')
            if vid and not any(x['id'] == vid for x in out):
                runs = ((v.get('title') or {}).get('runs') or [])
                title = ''.join(x.get('text', '') for x in runs) or \
                    ((v.get('title') or {}).get('simpleText') or '')
                th = ((v.get('thumbnail') or {}).get('thumbnails') or [])
                out.append({
                    'id': vid, 'title': title[:180],
                    'channel': ''.join(x.get('text', '') for x in
                                       (((v.get('ownerText') or {}).get('runs')) or []))[:60],
                    'length': (v.get('lengthText') or {}).get('simpleText', ''),
                    'views': (v.get('viewCountText') or {}).get('simpleText', ''),
                    'published': (v.get('publishedTimeText') or {}).get('simpleText', ''),
                    'thumb': (th[-1].get('url') if th else ''),
                })
        for k in node:
            _yt_pick(node[k], out)
    elif isinstance(node, list):
        for x in node:
            _yt_pick(x, out)
    return out


def _yt_token(node):
    if isinstance(node, dict):
        if 'continuationCommand' in node:
            t = (node['continuationCommand'] or {}).get('token')
            if t:
                return t
        for k in node:
            t = _yt_token(node[k])
            if t:
                return t
    elif isinstance(node, list):
        for x in node:
            t = _yt_token(x)
            if t:
                return t
    return None


def _yt_mem(key, ttl=_YT_MEM_TTL):
    hit = _YT_MEM.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    return None


def _yt_mem_put(key, val):
    if len(_YT_MEM) > 120:
        _YT_MEM.clear()
    _YT_MEM[key] = (time.time(), val)


def yt_search(q):
    query = (q.get('q', [''])[0] or '').strip()
    cursor = (q.get('cursor', [''])[0] or '').strip()
    if not query and not cursor:
        return {'ok': False, 'error': '缺少 q'}
    key = 'search:' + query + ':' + cursor[:40]
    hit = _yt_mem(key)
    if hit:
        return hit
    body = {'context': _yt_ctx()}
    if cursor:
        body['continuation'] = cursor
    else:
        body['query'] = query
    d = _innertube('search', body)
    items = _yt_pick(d, [])
    out = {'ok': True, 'query': query, 'items': items[:40],
           'cursor': _yt_token(d), 'count': len(items)}
    _yt_mem_put(key, out)
    return out


def yt_home(q):
    """个性化首页（有登录 cookie 时）优先；否则多主题聚合 feed"""
    cursor = (q.get('cursor', [''])[0] or '').strip()
    if _YT_SESSION['header']:
        try:
            key = 'home:' + cursor[:40]
            hit = _yt_mem(key)
            if hit:
                return hit
            body = {'context': _yt_ctx()}
            if cursor:
                body['continuation'] = cursor
            else:
                body['browseId'] = 'FEwhat_to_watch'
            d = _innertube('browse', body)
            items = _yt_pick(d, [])
            if items:
                out = {'ok': True, 'source': 'personalized', 'items': items[:40],
                       'cursor': _yt_token(d), 'logged': True, 'count': len(items)}
                _yt_mem_put(key, out)
                return out
        except Exception:
            pass
    import random
    seed = (q.get('seed', [''])[0] or '').strip()
    key0 = 'home-t:' + seed
    hit0 = _yt_mem(key0, 300)
    if hit0:
        return hit0
    rnd = random.Random(seed) if seed else random.Random()
    topics = rnd.sample(YT_TOPICS, 6)
    buckets = {}

    def one(t):
        try:
            buckets[t] = _yt_pick(_innertube('search', {'context': _yt_ctx(), 'query': t}), [])
        except Exception:
            buckets[t] = []

    import concurrent.futures as _cf
    with _cf.ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(one, topics))
    # 交错合并：每个主题轮流取一条，观感更像信息流
    items = []
    idx = 0
    while len(items) < 60:
        added = False
        for t in topics:
            b = buckets.get(t) or []
            if idx < len(b):
                items.append(b[idx])
                added = True
                if len(items) >= 60:
                    break
        if not added:
            break
        idx += 1
    seen, uniq = set(), []
    for it in items:
        if it['id'] in seen:
            continue
        seen.add(it['id'])
        uniq.append(it)
    out = {'ok': True, 'source': 'topics', 'topics': topics,
           'items': uniq[:60], 'logged': bool(_YT_SESSION['header']), 'count': len(uniq)}
    _yt_mem_put(key0, out)
    return out


def yt_thumb(q):
    vid = (q.get('id', [''])[0] or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
        return None, None
    os.makedirs(YT_THUMB_DIR, exist_ok=True)
    f = os.path.join(YT_THUMB_DIR, vid + '.jpg')
    if os.path.exists(f) and os.path.getsize(f) > 500:
        try:
            return open(f, 'rb').read(), 'image/jpeg'
        except Exception:
            pass
    for name in ('mqdefault.jpg', 'hqdefault.jpg', 'default.jpg'):
        try:
            with _yt_open('https://i.ytimg.com/vi/%s/%s' % (vid, name), timeout=15) as r:
                data = r.read()
            if data and len(data) > 500:
                try:
                    open(f, 'wb').write(data)
                except Exception:
                    pass
                return data, r.headers.get('Content-Type') or 'image/jpeg'
        except Exception:
            continue
    return None, None


def yt_login(q):
    """登录态：默认只报告状态；action=extract 时尝试从浏览器导 cookie（仅内存）"""
    act = (q.get('action', [''])[0] or '').strip()
    if act in ('extract', 'login', 'refresh'):
        prof = os.environ.get('ES_LEARN_PROFILE', '')
        for spec in (('edge:' + prof) if prof else 'edge', 'chrome', 'firefox'):
            try:
                got = _yt_extract_cookies(spec)
                if got:
                    _YT_SESSION.update({'header': got[0], 'at': int(time.time()), 'source': got[1]})
                    _YT_MEM.clear()
                    break
            except Exception:
                continue
    return {'ok': True, 'logged': bool(_YT_SESSION['header']),
            'source': _YT_SESSION['source'] or '', 'at': _YT_SESSION['at']}


def _yt_extract_cookies(spec):
    """用 yt-dlp 导浏览器 cookie 到临时文件，读完立刻删；值只留在内存"""
    binp = _ytdlp_bin()
    if not binp:
        return None
    tmpdir = os.path.join(DATA, 'yt-tmp')
    os.makedirs(tmpdir, exist_ok=True)
    tmp = os.path.join(tmpdir, 'ck-%d.txt' % int(time.time() * 1000))
    try:
        cmd = [binp, '--cookies-from-browser', spec, '--cookies', tmp,
               '--skip-download', '--simulate', '--no-warnings',
               'https://www.youtube.com/watch?v=dQw4w9WgXcQ']
        subprocess.run(cmd, capture_output=True, timeout=90)
        if not os.path.exists(tmp):
            return None
        pairs, src = [], spec
        with open(tmp, 'r', encoding='utf-8', errors='replace') as f:
            for ln in f:
                if ln.startswith('#') or not ln.strip():
                    continue
                cols = ln.rstrip('\n').split('\t')
                if len(cols) < 7:
                    continue
                host, name, val = cols[0].lower(), cols[5], cols[6]
                if not (host.endswith('youtube.com') or host.endswith('google.com')):
                    continue
                if not val or len(val) > 4000:
                    continue
                pairs.append('%s=%s' % (name, val))
        if not pairs:
            return None
        header = '; '.join(pairs)
        if len(header) > 7600:
            header = header[:7600]
        return header, src
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


# ---------------- YouTube 字幕（给 dsh-english-study 插件面板的嵌入播放器用） ----------------
# 只抓字幕文本，绝不下载视频/音频；临时文件解析完立刻删；
# 解析结果（纯文本 cues）小缓存 7 天，防重复抓。
YT_CACHE_DIR = os.path.join(DATA, 'yt-cache')
YT_TMP_DIR = os.path.join(DATA, 'yt-tmp')
YT_TTL = 7 * 86400
_YT_LOCK = threading.Lock()

def _ytdlp_bin():
    cand = [
        os.path.join(os.path.dirname(sys.executable), 'Scripts', 'yt-dlp.exe'),
        os.path.join(os.path.dirname(sys.executable), 'bin', 'yt-dlp.exe'),
        shutil.which('yt-dlp') or '',
    ]
    for c in cand:
        if c and os.path.exists(c):
            return c
    return None

def _yt_proxy():
    # 默认直连；需要代理时自己设 ES_PROXY=http://127.0.0.1:7890（或 socks5://...）
    p = os.environ.get('ES_PROXY', '')
    return None if p.lower() in ('direct', 'off', 'none', '') else p

def _parse_json3(path):
    with open(path, 'rb') as f:
        d = json.loads(f.read().decode('utf-8', 'replace'))
    out = []
    for e in d.get('events', []):
        if not e.get('segs'):
            continue
        txt = ''.join(x.get('utf8', '') for x in e['segs']).replace('\n', ' ').strip()
        if not txt:
            continue
        st = e.get('tStartMs', 0) / 1000.0
        out.append({'start': round(st, 2), 'end': round(st + max(0.5, e.get('dDurationMs', 2000) / 1000.0), 2),
                    'text': txt[:400]})
    return out

def _yt_purge_cache():
    try:
        now = time.time()
        for f in glob.glob(os.path.join(YT_CACHE_DIR, '*.json')):
            try:
                if now - os.path.getmtime(f) > YT_TTL:
                    os.remove(f)
            except Exception:
                pass
    except Exception:
        pass

def yt_recent():
    out = []
    try:
        for f in glob.glob(os.path.join(YT_CACHE_DIR, '*.json')):
            try:
                d = json.load(open(f, encoding='utf-8'))
                out.append({'video': os.path.basename(f)[:-5],
                            'count': d.get('count', len(d.get('cues') or [])),
                            'fetched': int(os.path.getmtime(f))})
            except Exception:
                pass
    except Exception:
        pass
    out.sort(key=lambda x: x.get('fetched', 0), reverse=True)
    return {'ok': True, 'items': out[:12]}

def yt_cues(q):
    vid = (q.get('video', [''])[0] or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
        raise ValueError('video 参数应为 11 位视频 ID')
    os.makedirs(YT_CACHE_DIR, exist_ok=True)
    _yt_purge_cache()
    cache = os.path.join(YT_CACHE_DIR, vid + '.json')
    if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < YT_TTL:
        try:
            hit = json.load(open(cache, encoding='utf-8'))
            return dict(hit, cached=True)
        except Exception:
            pass

    binp = _ytdlp_bin()
    if not binp:
        return {'ok': False, 'error': '本机没有 yt-dlp：装一下 yt-dlp 并加进 PATH（pip install yt-dlp）'}
    os.makedirs(YT_TMP_DIR, exist_ok=True)
    tmp = os.path.join(YT_TMP_DIR, vid + '-' + str(int(time.time() * 1000)))
    os.makedirs(tmp, exist_ok=True)
    try:
        cmd = [binp, '--skip-download', '--write-subs', '--write-auto-subs',
               '--sub-langs', 'en', '--sub-format', 'json3', '--no-playlist',
               '--quiet', '--no-warnings', '-o', os.path.join(tmp, 'sub'),
               'https://www.youtube.com/watch?v=' + vid]
        px = _yt_proxy()
        if px:
            cmd += ['--proxy', px]
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        files = glob.glob(os.path.join(tmp, '*.json3'))
        if not files:
            err = (r.stderr or b'').decode('utf-8', 'replace')[:300]
            has_sub = 'no subtitles' in err.lower() or 'requested format' in err.lower()
            return {'ok': False,
                    'error': '这个视频没有英文字幕' if has_sub else ('抓字幕失败：' + err)}
        cues = _parse_json3(files[0])
        if not cues:
            return {'ok': False, 'error': '字幕为空'}
        out = {'ok': True, 'video': vid, 'lang': 'en', 'count': len(cues), 'cues': cues}
        try:
            json.dump(out, open(cache, 'w', encoding='utf-8'), ensure_ascii=False)
        except Exception:
            pass
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)   # 临时文件用完即删

def _translate_part(part, depth=0):
    """把一组英文字幕翻成中文；返回与 part 等长的数组。
    长度不一致（模型截断/解析失败）时递归二分重试，仍失败则填空串。"""
    n = len(part)
    if not n:
        return []
    sys_p = ('你是英译中字幕翻译。用户给你一个 JSON 数组，每个元素是一句英文字幕。'
             '把每句翻成简体中文，只输出 JSON 对象 {"lines": ["中文1", "中文2"]}。'
             'lines 长度必须与输入完全一致，全部是中文译文，不能保留英文。')
    max_tok = max(900, min(4000, 170 * n + 400))
    txt, usage = call_llm([
        {'role': 'system', 'content': sys_p},
        {'role': 'user', 'content': json.dumps(part, ensure_ascii=False)},
    ], max_tokens=max_tok, json_mode=True)
    record_usage('translate', usage)
    obj = parse_json_obj(txt) or {}
    arr = obj.get('lines') if isinstance(obj, dict) else obj
    if isinstance(arr, list) and len(arr) == n:
        return [str(x).strip() for x in arr]
    if n > 1 and depth < 3:
        mid = n // 2
        return _translate_part(part[:mid], depth + 1) + _translate_part(part[mid:], depth + 1)
    return ['']


def subtitle_zh(body):
    lines = body.get('lines') or []
    if not isinstance(lines, list) or not lines:
        raise ValueError('empty lines')
    if not ai_ready():
        # 没有 AI 就原样返回英文字幕，面板照常显示，不报错也不发请求
        return {'lines': [str(x) for x in lines], 'local_only': True, 'note': 'local-only'}
    out = [None] * len(lines)
    pending = []
    for i, ln in enumerate(lines):
        txt = str(ln)
        k = 'sz:' + hashlib.sha1(txt.encode('utf-8')).hexdigest()[:20]
        hit = cache_get(k)
        if hit and hit.get('zh'):
            out[i] = hit['zh']
        else:
            pending.append((i, txt, k))
    CH = 10
    for j in range(0, len(pending), CH):
        chunk = pending[j:j + CH]
        got = _translate_part([c[1] for c in chunk])
        for (idx, txt, k), zh in zip(chunk, got):
            out[idx] = zh or ''
            if zh:
                cache_put(k, {'zh': zh})
    return {'lines': [x or '' for x in out]}

def translate(body):
    sentence = (body.get('sentence') or '').strip()[:800]
    if not sentence:
        raise ValueError('empty sentence')
    if not ai_ready():
        return {'translation': '翻译功能需要自己配置 AI（ES_API + ES_KEY）。发布版默认不连任何远程服务。',
                'note': 'local-only', 'local_only': True}
    ck = 'tr:' + hashlib.sha1(sentence.encode('utf-8')).hexdigest()[:20]
    hit = cache_get(ck)
    if hit:
        return dict(hit, cached=True)
    txt, usage = call_llm([
        {'role': 'system', 'content': '把用户给的英文字幕翻译成自然、地道的中文，只输出 JSON：{"translation":"中文译文","note":"可选的语感/难点提示，用中文"}。'},
        {'role': 'user', 'content': sentence},
    ], max_tokens=400)
    record_usage('translate', usage)
    obj = parse_json_obj(txt) or {}
    out = {'translation': obj.get('translation') or txt.strip(), 'note': obj.get('note') or '', 'usage': usage}
    cache_put(ck, {'translation': out['translation'], 'note': out['note']})
    return out

# ---------------- 词库 / 复习 ----------------

def word_row(r):
    d = dict(r)
    d['due_in'] = int(d['due'] - now_ts()) if d.get('due') else None
    return d

def list_words(q):
    c = db()
    status = q.get('status', ['all'])[0]
    kw = (q.get('q', [''])[0] or '').strip()
    sql = 'SELECT * FROM words WHERE 1=1'
    args = []
    if status in ('learning', 'learned'):
        sql += ' AND status=?'
        args.append(status)
    if kw:
        sql += ' AND (lemma LIKE ? OR meaning LIKE ?)'
        args += ['%' + kw + '%', '%' + kw + '%']
    sql += ' ORDER BY created DESC LIMIT 500'
    rows = [word_row(r) for r in c.execute(sql, args).fetchall()]
    c.close()
    return {'items': rows, 'count': len(rows)}

def add_word(body):
    lemma = (body.get('lemma') or body.get('word') or '').strip().lower()[:80]
    if not lemma:
        raise ValueError('empty lemma')
    ts = now_ts()
    c = db()
    cur = c.execute('SELECT id FROM words WHERE lemma=?', (lemma,)).fetchone()
    if cur:
        c.execute('''UPDATE words SET meaning=COALESCE(NULLIF(?,''),meaning),
            phonetic=COALESCE(NULLIF(?,''),phonetic), in_context=COALESCE(NULLIF(?,''),in_context),
            collocations=COALESCE(NULLIF(?,''),collocations), example=COALESCE(NULLIF(?,''),example),
            cefr=COALESCE(NULLIF(?,''),cefr), note=COALESCE(NULLIF(?,''),note),
            morphology=COALESCE(NULLIF(?,''),morphology),
            sentence=COALESCE(NULLIF(?,''),sentence), url=COALESCE(NULLIF(?,''),url),
            video=COALESCE(NULLIF(?,''),video), status='learning' WHERE id=?''',
            (body.get('meaning', ''), body.get('phonetic', ''), body.get('in_context', ''),
             body.get('collocations', ''), body.get('example', ''), body.get('cefr', ''),
             body.get('note', ''), body.get('morphology', ''), body.get('sentence', ''),
             body.get('url', ''), body.get('video', ''), cur['id']))
        wid = cur['id']
    else:
        cur = c.execute('''INSERT INTO words(lemma,word,phonetic,meaning,in_context,collocations,example,cefr,note,morphology,
            sentence,url,video,created,status,ease,interval,due,reps,lapses,last)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'learning', 2.5, 0, ?, 0, 0, NULL)''',
            (lemma, body.get('word', lemma), body.get('phonetic', ''), body.get('meaning', ''),
             body.get('in_context', ''), body.get('collocations', ''), body.get('example', ''),
             body.get('cefr', ''), body.get('note', ''), body.get('morphology', ''),
             body.get('sentence', ''), body.get('url', ''), body.get('video', ''), ts, ts))
        wid = cur.lastrowid
    c.commit()
    row = c.execute('SELECT * FROM words WHERE id=?', (wid,)).fetchone()
    c.close()
    return word_row(row)

def remove_word(body):
    lemma = (body.get('lemma') or '').strip().lower()
    c = db()
    c.execute('DELETE FROM words WHERE lemma=?', (lemma,))
    c.commit()
    c.close()
    return {'ok': True}

def due_words(limit=40):
    c = db()
    rows = [word_row(r) for r in c.execute(
        'SELECT * FROM words WHERE due IS NULL OR due<=? ORDER BY COALESCE(due,0) ASC LIMIT ?',
        (now_ts(), limit)).fetchall()]
    c.close()
    return {'items': rows, 'count': len(rows)}

def grade_word(body):
    wid = int(body.get('id'))
    g = (body.get('grade') or 'good').lower()
    c = db()
    r = c.execute('SELECT * FROM words WHERE id=?', (wid,)).fetchone()
    if not r:
        c.close()
        raise ValueError('not found')
    ease = r['ease'] or 2.5
    reps = r['reps'] or 0
    interval = r['interval'] or 0
    lapses = r['lapses'] or 0
    if g == 'again':
        reps = 0
        lapses += 1
        ease = max(1.3, ease - 0.2)
        due = now_ts() + 600
        interval = 0
    elif g == 'easy':
        reps += 1
        ease = min(3.2, ease + 0.15)
        interval = 1 if reps == 1 else (4 if reps == 2 else max(1, round(interval * ease * 1.3)))
        due = now_ts() + interval * 86400
    else:
        reps += 1
        interval = 1 if reps == 1 else (3 if reps == 2 else max(1, round(interval * ease)))
        due = now_ts() + interval * 86400
    status = 'learned' if reps >= 4 and lapses <= 1 else 'learning'
    c.execute('UPDATE words SET ease=?,reps=?,interval=?,due=?,lapses=?,status=?,last=? WHERE id=?',
              (ease, reps, interval, due, lapses, status, now_ts(), wid))
    c.execute('INSERT INTO reviews(day,ts,word_id,lemma,grade) VALUES(?,?,?,?,?)',
              (today(), now_ts(), wid, r['lemma'], g))
    c.commit()
    row = c.execute('SELECT * FROM words WHERE id=?', (wid,)).fetchone()
    c.close()
    return word_row(row)

# ---------------- 统计 ----------------

def tick(body):
    secs = max(0, min(3600, int(float(body.get('seconds', 0) or 0))))
    if secs == 0:
        return {'ok': True, 'seconds': 0}
    c = db()
    c.execute('''INSERT INTO immersion(day,seconds,updated) VALUES(?,?,?)
                 ON CONFLICT(day) DO UPDATE SET seconds=seconds+?, updated=?''',
              (today(), secs, now_ts(), secs, now_ts()))
    c.commit()
    c.close()
    return {'ok': True, 'seconds': secs}

def stats():
    c = db()
    t = today()
    d0 = (datetime.now(TZ) - timedelta(days=13)).strftime('%Y-%m-%d')
    immersion_rows = {r['day']: r['seconds'] for r in c.execute(
        'SELECT day,seconds FROM immersion WHERE day>=?', (d0,)).fetchall()}
    lookups_today = c.execute('SELECT COUNT(*) n, COUNT(DISTINCT LOWER(COALESCE(lemma,word))) w FROM lookups WHERE day=?', (t,)).fetchone()
    saved_total = c.execute('SELECT COUNT(*) n FROM words').fetchone()['n']
    saved_today = c.execute('SELECT COUNT(*) n FROM words WHERE created>=?', (int(datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()),)).fetchone()['n']
    learned = c.execute("SELECT COUNT(*) n FROM words WHERE status='learned'").fetchone()['n']
    due = c.execute('SELECT COUNT(*) n FROM words WHERE due IS NULL OR due<=?', (now_ts(),)).fetchone()['n']
    series = []
    words_by_day = {}
    for r in c.execute('SELECT created FROM words WHERE created>=?',
                       (int((datetime.now(TZ) - timedelta(days=90)).timestamp()),)).fetchall():
        if r['created']:
            dk = day_of(r['created'])
            words_by_day[dk] = words_by_day.get(dk, 0) + 1
    for i in range(13, -1, -1):
        d = (datetime.now(TZ) - timedelta(days=i)).strftime('%Y-%m-%d')
        series.append({'day': d, 'seconds': immersion_rows.get(d, 0), 'words': words_by_day.get(d, 0)})
    # streak：有沉浸或查词或复习的天
    active = set(immersion_rows.keys())
    active |= {r['day'] for r in c.execute('SELECT DISTINCT day FROM lookups WHERE day>=?', (d0,)).fetchall()}
    active |= {day_of(r['created']) for r in c.execute('SELECT created FROM words').fetchall() if r['created']}
    streak = 0
    cur = datetime.now(TZ)
    if t in active:
        streak += 1
    cur -= timedelta(days=1)
    while cur.strftime('%Y-%m-%d') in active:
        streak += 1
        cur -= timedelta(days=1)
    top = [dict(r) for r in c.execute(
        'SELECT LOWER(COALESCE(lemma,word)) lemma, COUNT(*) n FROM lookups WHERE day>=? GROUP BY 1 ORDER BY n DESC LIMIT 12',
        ((datetime.now(TZ) - timedelta(days=30)).strftime('%Y-%m-%d'),)).fetchall()]
    heat = {}
    for r in c.execute('SELECT day,seconds FROM immersion WHERE day>=?', ((datetime.now(TZ) - timedelta(days=120)).strftime('%Y-%m-%d'),)).fetchall():
        heat[r['day']] = r['seconds']
    for r in c.execute('SELECT day,COUNT(*) n FROM lookups WHERE day>=? GROUP BY day',
                       ((datetime.now(TZ) - timedelta(days=120)).strftime('%Y-%m-%d'),)).fetchall():
        heat[r['day']] = heat.get(r['day'], 0) + r['n'] * 60
    c.close()
    return {
        'today': {'immersion_sec': immersion_rows.get(t, 0), 'lookups': lookups_today['n'],
                  'distinct_words': lookups_today['w'], 'saved': saved_today},
        'totals': {'saved': saved_total, 'learned': learned, 'due': due, 'streak': streak},
        'series': series, 'top': top, 'heat': heat,
        'goal_minutes': 30,
        'ai': usage_stats(),
    }

def lookups(q):
    days = int(q.get('days', ['7'])[0])
    day = q.get('day', [''])[0]
    c = db()
    if day:
        rows = [dict(r) for r in c.execute('SELECT * FROM lookups WHERE day=? ORDER BY ts DESC LIMIT 500', (day,)).fetchall()]
    else:
        since = (datetime.now(TZ) - timedelta(days=days)).strftime('%Y-%m-%d')
        rows = [dict(r) for r in c.execute('SELECT * FROM lookups WHERE day>=? ORDER BY ts DESC LIMIT 800', (since,)).fetchall()]
    grouped = {}
    for r in rows:
        grouped.setdefault(r['day'], []).append(r)
    c.close()
    return {'days': grouped, 'total': len(rows)}

def export_csv():
    c = db()
    rows = c.execute('SELECT * FROM words ORDER BY created DESC').fetchall()
    c.close()
    head = 'word,lemma,phonetic,meaning,collocations,cefr,sentence,status,reps,interval,ease\n'
    def esc(s):
        s = '' if s is None else str(s)
        return '"' + s.replace('"', '""').replace('\n', ' ') + '"'
    lines = [head.rstrip('\n')]
    for r in rows:
        lines.append(','.join(esc(r[k]) for k in ['word', 'lemma', 'phonetic', 'meaning', 'collocations', 'cefr', 'sentence', 'status', 'reps', 'interval', 'ease']))
    return '\n'.join(lines)

# ---------------- 本地词典（零 token） ----------------

DICT_DB = os.path.join(DATA, 'dict.db')

def _dict_conn():
    c = sqlite3.connect(DICT_DB, timeout=10)
    c.row_factory = sqlite3.Row
    return c

def lemma_candidates(w):
    out = []
    if w.endswith('ies'):
        out.append(w[:-3] + 'y')
    if w.endswith('ves'):
        out += [w[:-3] + 'f', w[:-3] + 'fe']
    if w.endswith('es'):
        out.append(w[:-2])
    if w.endswith('s'):
        out.append(w[:-1])
    if w.endswith('ing'):
        base = w[:-3]
        out += [base, base + 'e']
        if len(base) > 2 and base[-1] == base[-2]:
            out.append(base[:-1])
    if w.endswith('ed'):
        base = w[:-2]
        out += [base, w[:-1], base + 'e']
        if len(base) > 2 and base[-1] == base[-2]:
            out.append(base[:-1])
    if w.endswith('er'):
        out += [w[:-2], w[:-1]]
    if w.endswith('est'):
        out += [w[:-3], w[:-2]]
    if w.endswith('ly'):
        out.append(w[:-2])
    return [x for x in dict.fromkeys(out) if x and x != w]

def dict_lookup(word):
    w = (word or '').strip().lower().strip("'\"“”‘’.,!?;:()[]{}")
    if not w:
        return {'found': False, 'query': w}
    if not os.path.exists(DICT_DB):
        return {'found': False, 'query': w, 'error': 'dict-not-built'}
    c = _dict_conn()
    try:
        row = c.execute('SELECT * FROM dict WHERE word=?', (w,)).fetchone()
        source = 'exact' if row else ''
        if not row:
            row = c.execute('SELECT d.* FROM forms f JOIN dict d ON d.word=f.word WHERE f.form=? LIMIT 1', (w,)).fetchone()
            source = 'form' if row else ''
        if not row:
            for cand in lemma_candidates(w):
                row = c.execute('SELECT * FROM dict WHERE word=?', (cand,)).fetchone()
                if row:
                    source = 'lemma:' + cand
                    break
        if not row:
            return {'found': False, 'query': w}
        d = dict(row)
        d['found'] = True
        d['query'] = w
        d['source'] = source
        return d
    finally:
        c.close()

# ---------------- 句子收藏 ----------------

def sentences_list(q):
    kw = (q.get('q', [''])[0] or '').strip()
    c = db()
    if kw:
        rows = c.execute('SELECT * FROM sentences WHERE text LIKE ? OR translation LIKE ? ORDER BY ts DESC LIMIT 300',
                         ('%' + kw + '%', '%' + kw + '%')).fetchall()
    else:
        rows = c.execute('SELECT * FROM sentences ORDER BY ts DESC LIMIT 300').fetchall()
    c.close()
    return {'items': [dict(r) for r in rows], 'count': len(rows)}

def sentence_add(body):
    text = (body.get('text') or '').strip()[:800]
    if not text:
        raise ValueError('empty text')
    tr = (body.get('translation') or '').strip()[:800]
    if not tr and body.get('auto_translate'):
        try:
            tr = translate({'sentence': text}).get('translation', '')
        except Exception:
            tr = ''
    c = db()
    cur = c.execute('''INSERT INTO sentences(day,ts,text,translation,note,url,video)
        VALUES(?,?,?,?,?,?,?)''',
        (today(), now_ts(), text, tr, (body.get('note') or '')[:400],
         (body.get('url') or '')[:500], (body.get('video') or '')[:200]))
    c.commit()
    row = c.execute('SELECT * FROM sentences WHERE id=?', (cur.lastrowid,)).fetchone()
    c.close()
    return dict(row)

def sentence_remove(body):
    c = db()
    c.execute('DELETE FROM sentences WHERE id=?', (int(body.get('id')),))
    c.commit()
    c.close()
    return {'ok': True}

# ---------------- 听写 ----------------

def norm(s):
    s = (s or '').lower()
    s = re.sub(r"[^a-z0-9' ]+", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def dictation_next(q):
    kind = q.get('kind', ['sentence'])[0]
    n = int(q.get('n', ['10'])[0])
    c = db()
    items = []
    if kind == 'word':
        rows = c.execute("SELECT id, lemma, sentence, meaning FROM words WHERE sentence<>'' ORDER BY RANDOM() LIMIT ?", (n,)).fetchall()
        for r in rows:
            items.append({'kind': 'word', 'ref_id': r['id'], 'text': r['sentence'],
                          'hint': r['meaning'] or '', 'label': r['lemma']})
    else:
        rows = c.execute('SELECT id, text, translation, video FROM sentences ORDER BY RANDOM() LIMIT ?', (n,)).fetchall()
        for r in rows:
            items.append({'kind': 'sentence', 'ref_id': r['id'], 'text': r['text'],
                          'hint': r['translation'] or '', 'label': r['video'] or ''})
    c.close()
    return {'items': items, 'count': len(items)}

def dictation_check(body):
    kind = (body.get('kind') or 'sentence')[:20]
    ref_id = body.get('ref_id')
    target = (body.get('text') or '').strip()[:800]
    typed = (body.get('input') or '').strip()[:800]
    if not target:
        raise ValueError('empty target')
    import difflib
    a = norm(target).split()
    b = norm(typed).split()
    sm = difflib.SequenceMatcher(None, a, b)
    score = round(sm.ratio() * 100, 1)
    correct = 1 if score >= 92 else 0
    diff = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        diff.append({'tag': tag, 'target': ' '.join(a[i1:i2]), 'input': ' '.join(b[j1:j2])})
    c = db()
    c.execute('''INSERT INTO dictation(day,ts,kind,ref_id,text,input,correct,score)
                 VALUES(?,?,?,?,?,?,?,?)''',
              (today(), now_ts(), kind, int(ref_id or 0), target, typed, correct, score))
    c.commit()
    c.close()
    return {'score': score, 'correct': correct, 'target': target, 'diff': diff}

def dictation_stats():
    c = db()
    t = today()
    tot = c.execute('SELECT COUNT(*) n, AVG(score) s, SUM(correct) c FROM dictation WHERE day=?', (t,)).fetchone()
    all7 = c.execute('SELECT COUNT(*) n, AVG(score) s FROM dictation WHERE day>=?',
                     ((datetime.now(TZ) - timedelta(days=7)).strftime('%Y-%m-%d'),)).fetchone()
    c.close()
    return {'today': {'n': tot['n'], 'avg': round(tot['s'] or 0, 1), 'correct': tot['c'] or 0},
            'week': {'n': all7['n'], 'avg': round(all7['s'] or 0, 1)}}

# ---------------- 每周报告 ----------------

def week_bounds(offset=0):
    now = datetime.now(TZ)
    start = (now - timedelta(days=now.weekday()) - timedelta(weeks=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=7)
    return start, end

def report_data(wname='this'):
    offset = 1 if wname == 'last' else 0
    start, end = week_bounds(offset)
    pstart, pend = week_bounds(offset + 1)
    s_day, e_day = start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')
    p_s = pstart.strftime('%Y-%m-%d')
    c = db()
    def imm(s, e):
        r = c.execute('SELECT COALESCE(SUM(seconds),0) s FROM immersion WHERE day>=? AND day<?', (s, e)).fetchone()
        return r['s'] or 0
    cur_imm, prev_imm = imm(s_day, e_day), imm(p_s, s_day)
    lk = c.execute('SELECT COUNT(*) n, COUNT(DISTINCT LOWER(COALESCE(lemma,word))) d FROM lookups WHERE day>=? AND day<?',
                   (s_day, e_day)).fetchone()
    p_lk = c.execute('SELECT COUNT(*) n FROM lookups WHERE day>=? AND day<?', (p_s, s_day)).fetchone()['n']
    new_words = [dict(r) for r in c.execute(
        'SELECT lemma, meaning, cefr FROM words WHERE created>=? AND created<? ORDER BY created DESC',
        (int(start.timestamp()), int(end.timestamp()))).fetchall()]
    p_new = c.execute('SELECT COUNT(*) n FROM words WHERE created>=? AND created<?',
                      (int(pstart.timestamp()), int(start.timestamp()))).fetchone()['n']
    rv = c.execute('SELECT grade, COUNT(*) n FROM reviews WHERE day>=? AND day<? GROUP BY grade',
                   (s_day, e_day)).fetchall()
    grades = {r['grade']: r['n'] for r in rv}
    rv_total = sum(grades.values())
    rv_good = grades.get('good', 0) + grades.get('easy', 0)
    sent = c.execute('SELECT COUNT(*) n FROM sentences WHERE day>=? AND day<?', (s_day, e_day)).fetchone()['n']
    dic = c.execute('SELECT COUNT(*) n, AVG(score) s FROM dictation WHERE day>=? AND day<?', (s_day, e_day)).fetchone()
    top = [dict(r) for r in c.execute(
        'SELECT LOWER(COALESCE(lemma,word)) lemma, COUNT(*) n FROM lookups WHERE day>=? AND day<? GROUP BY 1 ORDER BY n DESC LIMIT 8',
        (s_day, e_day)).fetchall()]
    vids = [dict(r) for r in c.execute(
        "SELECT video, COUNT(*) n FROM lookups WHERE day>=? AND day<? AND video<>'' GROUP BY 1 ORDER BY n DESC LIMIT 5",
        (s_day, e_day)).fetchall()]
    active = set()
    for r in c.execute('SELECT day FROM immersion WHERE day>=? AND day<? AND seconds>0', (s_day, e_day)):
        active.add(r['day'])
    for r in c.execute('SELECT DISTINCT day FROM lookups WHERE day>=? AND day<?', (s_day, e_day)):
        active.add(r['day'])
    for r in c.execute('SELECT created FROM words WHERE created>=? AND created<?', (int(start.timestamp()), int(end.timestamp()))):
        if r['created']:
            active.add(day_of(r['created']))
    c.close()
    return {
        'label': '%s ~ %s' % (s_day, (end - timedelta(days=1)).strftime('%Y-%m-%d')),
        'start': s_day, 'end': (end - timedelta(days=1)).strftime('%Y-%m-%d'),
        'immersion': {'sec': cur_imm, 'prev': prev_imm},
        'lookups': {'count': lk['n'], 'distinct': lk['d'] or 0, 'prev': p_lk},
        'new_words': {'count': len(new_words), 'prev': p_new, 'items': new_words},
        'reviews': {'count': rv_total, 'good': rv_good, 'again': grades.get('again', 0),
                    'accuracy': round(rv_good * 100.0 / rv_total, 1) if rv_total else 0},
        'sentences': {'count': sent},
        'dictation': {'count': dic['n'] or 0, 'avg': round(dic['s'] or 0, 1)},
        'top': top, 'videos': vids, 'active_days': len(active),
    }

def fmt_hm(sec):
    sec = int(sec or 0)
    h, m = sec // 3600, (sec % 3600) // 60
    return ('%d 小时 %d 分' % (h, m)) if h else ('%d 分' % m)

def report_markdown(wname='this'):
    d = report_data(wname)
    def delta(a, b):
        if not b:
            return '（上周无数据）'
        p = (a - b) * 100.0 / b
        return '%s%.0f%%' % ('+' if p >= 0 else '', p)
    lines = []
    lines.append('# 本周学习报告（%s）' % d['label'])
    lines.append('')
    lines.append('## 一、总量')
    if d['immersion']['prev']:
        lines.append('- 沉浸时长：**%s**（上周 %s，%s）' % (fmt_hm(d['immersion']['sec']), fmt_hm(d['immersion']['prev']), delta(d['immersion']['sec'], d['immersion']['prev'])))
    else:
        lines.append('- 沉浸时长：**%s**（上周无数据）' % fmt_hm(d['immersion']['sec']))
    lines.append('- 查词次数：**%d 次**（%d 个不同词，上周 %d 次）' % (d['lookups']['count'], d['lookups']['distinct'], d['lookups']['prev']))
    lines.append('- 新增生词：**%d 个**（上周 %d 个）' % (d['new_words']['count'], d['new_words']['prev']))
    lines.append('- 复习：**%d 次**，正确率 **%.1f%%**（忘了 %d 次）' % (d['reviews']['count'], d['reviews']['accuracy'], d['reviews']['again']))
    lines.append('- 收藏句子：**%d 句**；听写：**%d 次**，平均 **%.1f 分**' % (d['sentences']['count'], d['dictation']['count'], d['dictation']['avg']))
    lines.append('- 有效学习天数：**%d / 7**' % d['active_days'])
    lines.append('')
    lines.append('## 二、本周新词')
    if d['new_words']['items']:
        for w in d['new_words']['items']:
            lines.append('- **%s** %s%s' % (w['lemma'], (w['meaning'] or '').strip(), ('（' + w['cefr'] + '）') if w.get('cefr') else ''))
    else:
        lines.append('- 本周没有新增生词。')
    lines.append('')
    lines.append('## 三、最常查的词')
    if d['top']:
        lines.append('、'.join('%s×%d' % (t['lemma'], t['n']) for t in d['top']))
    else:
        lines.append('- 无')
    lines.append('')
    lines.append('## 四、最常看的视频')
    if d['videos']:
        for v in d['videos']:
            lines.append('- %s（查词 %d 次）' % (v['video'][:80], v['n']))
    else:
        lines.append('- 无')
    lines.append('')
    lines.append('## 五、下周建议')
    if d['reviews']['count'] == 0:
        lines.append('- 本周没有复习记录：每天花 5 分钟打开「复习」页，把到期词过一遍。')
    elif d['reviews']['accuracy'] < 70:
        lines.append('- 复习正确率偏低（%.0f%%）：说明词还没记牢，建议每个词多造一个句子再存。' % d['reviews']['accuracy'])
    if d['immersion']['sec'] < 1800 * 3:
        lines.append('- 沉浸时长偏少：每天至少 20–30 分钟带字幕的输入，比刷单词更有效。')
    if d['dictation']['count'] == 0:
        lines.append('- 试试「听写」页：把本周收藏的句子听一遍、打一遍，检验是不是真听懂了。')
    if not lines[-1].startswith('-'):
        lines.append('- 节奏不错，保持。')
    return '\n'.join(lines)

def save_report(wname='this'):
    d = report_data(wname)
    outdir = os.path.join(BASE, '..', 'reports')
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, d['start'] + '.md')
    open(path, 'w', encoding='utf-8').write(report_markdown(wname))
    return path

def report_scheduler():
    while True:
        try:
            now = datetime.now(TZ)
            if now.weekday() == 6 and now.hour >= 20:
                d = report_data('this')
                outdir = os.path.join(BASE, '..', 'reports')
                path = os.path.join(outdir, d['start'] + '.md')
                if not os.path.exists(path):
                    save_report('this')
        except Exception:
            pass
        time.sleep(600)

# ---------------- HTTP ----------------

class H(BaseHTTPRequestHandler):
    server_version = 'zs-lite/1.0'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg, code=400):
        self._json({'error': msg}, code)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)
        try:
            if p == '/api/health':
                return self._json({'ok': True, 'ai': ai_ready(),
                                   'model': MODEL if ai_ready() else '',
                                   'local_only': not ai_ready(),
                                   'port': PORT, 'dict': os.path.exists(DICT_DB),
                                   # 面板用这两个字段决定要不要显示「怎么装 yt-dlp / 怎么配 key」的引导
                                   'ytdlp': bool(shutil.which('yt-dlp')),
                                   'innertube': bool(YT_IK),
                                   'time': now_ts()})
            if p == '/api/stats':
                return self._json(stats())
            if p == '/api/words':
                return self._json(list_words(q))
            if p == '/api/words/lemmas':
                c = db()
                rows = c.execute('SELECT lemma FROM words').fetchall()
                c.close()
                return self._json({'lemmas': [r['lemma'] for r in rows]})
            if p == '/api/review/due':
                return self._json(due_words(int(q.get('limit', ['40'])[0])))
            if p == '/api/lookups':
                return self._json(lookups(q))
            if p == '/api/yt/home':
                return self._json(yt_home(q))
            if p == '/api/yt/search':
                return self._json(yt_search(q))
            if p == '/api/yt/login':
                return self._json(yt_login(q))
            if p == '/api/yt/thumb':
                data, ctype = yt_thumb(q)
                if not data:
                    return self._json({'ok': False, 'error': '没有缩略图'}, 404)
                self.send_response(200)
                self.send_header('Content-Type', ctype or 'image/jpeg')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'max-age=86400')
                self._cors()
                self.end_headers()
                self.wfile.write(data)
                return None
            if p == '/api/yt/recent':
                return self._json(yt_recent())
            if p == '/api/yt/cues':
                return self._json(yt_cues(q))
            if p == '/api/dict':
                return self._json(dict_lookup(q.get('word', [''])[0]))
            if p == '/api/sentences':
                return self._json(sentences_list(q))
            if p == '/api/dictation/next':
                return self._json(dictation_next(q))
            if p == '/api/dictation/stats':
                return self._json(dictation_stats())
            if p == '/api/report':
                return self._json(report_data(q.get('week', ['this'])[0]))
            if p == '/api/report/md':
                md = report_markdown(q.get('week', ['this'])[0])
                data = md.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/markdown; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self._cors()
                self.end_headers()
                self.wfile.write(data)
                return
            if p == '/api/export.csv':
                data = export_csv().encode('utf-8-sig')
                self.send_response(200)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.send_header('Content-Disposition', 'attachment; filename="english-study-words.csv"')
                self.send_header('Content-Length', str(len(data)))
                self._cors()
                self.end_headers()
                self.wfile.write(data)
                return
            # static
            if p in ('/', '/index.html'):
                return self._file(os.path.join(WEB, 'dashboard.html'), 'text/html; charset=utf-8')
            if p in ('/review', '/review.html'):
                return self._file(os.path.join(WEB, 'review.html'), 'text/html; charset=utf-8')
            if p in ('/words', '/words.html'):
                return self._file(os.path.join(WEB, 'words.html'), 'text/html; charset=utf-8')
            if p in ('/manifest.webmanifest', '/manifest.json'):
                return self._file(os.path.join(WEB, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8')
            if p == '/sw.js':
                return self._file(os.path.join(WEB, 'sw.js'), 'application/javascript; charset=utf-8')
            if p.startswith('/icons/'):
                name = os.path.basename(p)
                if name not in ('icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'):
                    return self._err('not found', 404)
                return self._file(os.path.join(WEB, 'icons', name), 'image/png', cache='public, max-age=86400')
            if p in ('/sentences', '/sentences.html'):
                return self._file(os.path.join(WEB, 'sentences.html'), 'text/html; charset=utf-8')
            if p in ('/dictation', '/dictation.html'):
                return self._file(os.path.join(WEB, 'dictation.html'), 'text/html; charset=utf-8')
            if p in ('/report', '/report.html'):
                return self._file(os.path.join(WEB, 'report.html'), 'text/html; charset=utf-8')
            return self._err('not found', 404)
        except Exception as e:
            return self._err(str(e), 500)

    def _file(self, path, ctype, cache='no-store'):
        if not os.path.exists(path):
            return self._err('missing static file: ' + os.path.basename(path), 404)
        data = open(path, 'rb').read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache)
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            b = self._body()
            if p == '/api/explain':
                return self._json(explain(b))
            if p == '/api/subtitle_zh':
                return self._json(subtitle_zh(b))
            if p == '/api/translate':
                return self._json(translate(b))
            if p == '/api/words/add':
                return self._json(add_word(b))
            if p == '/api/words/remove':
                return self._json(remove_word(b))
            if p == '/api/review/grade':
                return self._json(grade_word(b))
            if p == '/api/tick':
                return self._json(tick(b))
            if p == '/api/lookup-log':
                return self._json(lookup_log(b))
            if p == '/api/sentences/add':
                return self._json(sentence_add(b))
            if p == '/api/sentences/remove':
                return self._json(sentence_remove(b))
            if p == '/api/dictation/check':
                return self._json(dictation_check(b))
            if p == '/api/report/save':
                return self._json({'ok': True, 'path': save_report(b.get('week', 'this'))})
            return self._err('not found', 404)
        except urllib.error.HTTPError as e:
            return self._err('upstream ai http %s: %s' % (e.code, e.read()[:200]), 502)
        except Exception as e:
            return self._err('%s: %s' % (type(e).__name__, e), 500)

class S(ThreadingHTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    print('English Study gateway -> http://127.0.0.1:%d  (bind %s)' % (PORT, HOST))
    print('AI:', ('ready (' + MODEL + ')') if ai_ready() else '未配置（纯本地词典模式，不外发请求）')
    print('db:', DB)
    try:
        import socket as _s
        ips = []
        for info in _s.getaddrinfo(_s.gethostname(), None, _s.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
        for ip in ips:
            print('LAN  (手机用这个): http://%s:%d' % (ip, PORT))
    except Exception:
        pass
    threading.Thread(target=report_scheduler, daemon=True).start()
    print('[local] 数据目录:', DATA, '（全部本地 SQLite，无云同步）', flush=True)
    S((HOST, PORT), H).serve_forever()
