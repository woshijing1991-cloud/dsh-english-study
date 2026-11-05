# -*- coding: utf-8 -*-
"""把 ECDICT 的 csv 构建成本地词典 data/dict.db（两遍扫描：先词条、后词形映射）。

用法：
    # 1) 下载 ECDICT（https://github.com/skywind3000/ECDICT，MIT），把 ecdict.csv 放进 data/
    # 2) python gateway/build_dict.py
可选：用 ES_ECDICT 指定 csv 路径、ES_DATA_DIR 指定输出目录。
"""
import csv, os, sqlite3, time

BASE = os.path.dirname(os.path.abspath(__file__))          # .../gateway
DATA = os.environ.get('ES_DATA_DIR') or os.path.join(BASE, '..', 'data')
SRC = os.environ.get('ES_ECDICT') or os.path.join(DATA, 'ecdict.csv')
DST = os.path.join(DATA, 'dict.db')

if not os.path.exists(SRC):
    raise SystemExit('找不到 %s —— 先把 ECDICT 的 ecdict.csv 放进 data/，或用 ES_ECDICT 指定路径。' % SRC)
if os.path.exists(DST):
    os.remove(DST)
con = sqlite3.connect(DST)
con.execute('PRAGMA journal_mode=OFF')
con.execute('PRAGMA synchronous=OFF')
con.execute('CREATE TABLE dict(word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT, definition TEXT, pos TEXT, collins INT, oxford INT, tag TEXT, bnc INT, frq INT)')
con.execute('CREATE TABLE forms(form TEXT, word TEXT)')
t0 = time.time()
n = 0
kept = 0
batch = []
forms = []
with open(SRC, encoding='utf-8', errors='replace', newline='') as f:
    rd = csv.reader(f)
    next(rd, None)
    for r in rd:
        n += 1
        if len(r) < 11:
            continue
        word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange = r[:11]
        word = word.strip().lower()
        if not word or ' ' in word:
            continue
        if not translation.strip() and not definition.strip():
            continue

        def i(x):
            try:
                return int(x) if x else 0
            except Exception:
                return 0
        batch.append((word, phonetic, translation.replace('\\n', '；').replace('\n', '；'),
                      definition.replace('\\n', '；').replace('\n', '；'), pos,
                      i(collins), i(oxford), tag, i(bnc), i(frq)))
        for part in (exchange or '').split('/'):
            if ':' in part:
                k, v = part.split(':', 1)
                v = v.strip().lower()
                if v and k in ('p', 'd', 'i', '3', 's', 'r', 't'):
                    forms.append((v, word))
        kept += 1
        if len(batch) >= 20000:
            con.executemany('INSERT OR REPLACE INTO dict VALUES(?,?,?,?,?,?,?,?,?,?)', batch)
            batch = []
        if len(forms) >= 40000:
            con.executemany('INSERT INTO forms VALUES(?,?)', forms)
            forms = []
con.executemany('INSERT OR REPLACE INTO dict VALUES(?,?,?,?,?,?,?,?,?,?)', batch)
con.executemany('INSERT INTO forms VALUES(?,?)', forms)
con.commit()
con.execute('CREATE INDEX idx_forms ON forms(form)')
con.commit()
con.close()
print('read', n, 'kept', kept, 'sec', round(time.time() - t0, 1),
      'size MB', round(os.path.getsize(DST) / 1048576, 1))
