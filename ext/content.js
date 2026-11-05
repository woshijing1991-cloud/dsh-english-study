// English Study · YouTube 内容脚本
// 功能：字幕增强条（逐词可点）· AI 语境解释 · 保存生词 · 整句翻译 · 沉浸计时 · 听力模糊
(() => {
  'use strict';
  try { document.documentElement.setAttribute('data-zs-lite', 'boot'); } catch (e) {}
  const DEF = 'http://127.0.0.1:8788';
  let GATE = DEF;
  let savedLemmas = new Set();
  let blurOn = false;
  let host = null, shadow = null, bar = null, panel = null, tip = null;
  let lastCaption = '';
  let tickTimer = null;
  let observer = null;
  let cues = [];              // [{start,end,text}] 直接从字幕轨解析
  let trackLang = '';
  let trackReady = false;
  let curVideoId = '';
  let capturedTimedtextFor = '';
  let lastCueShownAt = 0;
  let __cuesHiddenState = -1;
  let ccTriedFor = '';
  let ccClickedAt = 0;
  let hintShownFor = '';
  let hiddenByMenu = false;
  let ccAttempts = 0, ccAttemptsFor = '';
  let hideNative = true;
  let subMode = 'en';
  try { subMode = localStorage.getItem('zs_sub_mode') || 'en'; } catch (e) {}   // 隐藏 YouTube 原生字幕，只留我们自己的条
  let pauseOnWord = true;  // 点词自动暂停
  let panelHost = null, panelShadow = null;

  const STYLE = `
  :host{all:initial}
  *{box-sizing:border-box}
  .bar{position:absolute;left:0;top:0;z-index:99999;
    width:min(92%,1020px);background:rgba(18,20,26,.92);color:#f2f4f8;border-radius:12px;
    padding:10px 14px;font:16px/1.65 ui-sans-serif,system-ui,"Segoe UI",sans-serif;
    box-shadow:0 8px 28px rgba(0,0,0,.38);backdrop-filter:blur(6px);display:none}
  .bar.on{display:block}
  .bar.dragging{outline:1px dashed rgba(255,255,255,.35);opacity:.95}
  .dragbar{display:flex;align-items:center;gap:8px;cursor:move;user-select:none;
    margin:-4px -6px 6px;padding:2px 4px;border-radius:8px;opacity:.5;font-size:11px;color:#cfd6e4}
  .dragbar:hover{opacity:1}
  .dragbar .grip{letter-spacing:2px;font-size:13px}
  .line{max-height:5.2em;overflow:auto;text-align:center;padding:0 4px}
  .w{cursor:pointer;border-radius:4px;padding:0 1px;transition:background .12s}
  .w:hover{background:rgba(120,170,255,.35);text-decoration:underline}
  .w.saved{color:#7fe0a8;border-bottom:1px solid rgba(127,224,168,.6)}
  .w:focus{outline:none;background:rgba(120,170,255,.45)}
  .tools{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12.5px;color:#aab3c2;flex-wrap:wrap}
  .tools button{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e8ecf4;
    border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer}
  .tools button:hover{background:rgba(255,255,255,.16)}
  .tools button#zs-pause.paused-state{color:#cfe0ff;border-color:rgba(120,170,255,.55)}
  .tools .tr{color:#cfe0ff;font-size:13px;min-height:0}
  .tools .sp{flex:1}
  .panel{position:fixed;z-index:2147483647;width:360px;max-height:70vh;overflow:auto;
    pointer-events:auto;touch-action:none;cursor:move;
    background:#fff;color:#1c1f26;border-radius:14px;padding:16px 16px 14px;
    box-shadow:0 18px 50px rgba(0,0,0,.35);font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
  .panel h3{margin:0 0 2px;font-size:22px;letter-spacing:-.3px;display:flex;align-items:center;gap:8px}
  .panel .phead{cursor:move;user-select:none}
  .panel.dragging{opacity:.97}
  .panel .ph{color:#6b7280;font-size:12.5px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .panel .sec{margin:9px 0}
  .panel .k{font-size:11.5px;color:#8a91a0;margin-bottom:2px}
  .panel .txt{font-size:13.5px}
  .panel .cefr{font-size:11px;background:#eef2ff;color:#2f4faf;border-radius:5px;padding:1px 6px}
  .panel .acts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .panel .acts button{border:1px solid #e2e6ee;background:#fff;border-radius:9px;padding:8px 12px;
    font-size:13px;cursor:pointer}
  .panel .acts .pri{background:#2f6feb;border-color:#2f6feb;color:#fff}
  .panel .acts button:disabled{opacity:.55;cursor:default}
  .panel .close{position:absolute;right:10px;top:8px;border:none;background:none;font-size:16px;
    color:#9aa1ad;cursor:pointer}
  .panel .load{color:#6b7280;font-size:13px;padding:14px 0}
  .hint{position:absolute;right:14px;bottom:64px;z-index:99998;background:rgba(0,0,0,.6);color:#fff;
    font:12px/1.5 ui-sans-serif,system-ui;padding:6px 10px;border-radius:8px;display:none}
  `;

  function gw(path, opts) {
    const o = opts || {};
    const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'api', base: GATE, path, method: o.method || 'GET', body }, res => {
          if (!res) return reject(new Error('扩展后台无响应'));
          if (res.error) return reject(new Error(res.error));
          if (res.data && res.data.error) return reject(new Error(res.data.error));
          resolve(res.data);
        });
      } catch (e) { reject(e); }
    });
  }

  // 带超时的网关调用：避免网关慢/挂时把 zhFetching 卡死
  function gwT(path, opts, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('gateway timeout'));
      }, ms || 90000);
      gw(path, opts).then(d => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(d);
      }).catch(e => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function forceEnglishCC() {
    try { chrome.runtime.sendMessage({ type: 'english-cc' }, () => {}); } catch (e) {}
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(['gateway', 'blur', 'hideNative', 'barPos', 'panelPos', 'pauseOnWord'], v => {
        if (v.gateway) GATE = v.gateway;
        blurOn = !!v.blur;
        hideNative = v.hideNative !== false;   // 默认隐藏
        pauseOnWord = v.pauseOnWord !== false; // 默认暂停
        if (v.barPos) barPosSaved = v.barPos;
        if (v.panelPos) panelPosSaved = v.panelPos;
        applyBlur();
        applyNativeHidden();
        refreshSaved();
      });
    } catch (e) { refreshSaved(); }
  }

  // 隐藏/显示 YouTube 自带的字幕层（数据仍然读得到，只是不画出来）
  function applyNativeHidden() {
    const id = 'zs-native-hidden';
    // 只有我们自己能画出字幕时才隐藏原生字幕；cues 为空就恢复原生，避免一片空白
    const wantHide = hideNative && cues.length > 0;
    let el = document.getElementById(id);
    if (wantHide && !el) {
      el = document.createElement('style');
      el.id = id;
      el.textContent = `
        .ytp-caption-window-container{display:none !important}
        .caption-window.ytp-caption-window-bottom{display:none !important}
      `;
      document.documentElement.appendChild(el);
    } else if (!wantHide && el) {
      el.remove();
    }
  }

  function refreshSaved() {
    gw('/api/words/lemmas').then(d => {
      savedLemmas = new Set((d.lemmas || []).map(s => s.toLowerCase()));
      if (bar) renderLine(lastCaption);
    }).catch(() => {});
  }

  function applyBlur() {
    const id = 'zs-blur-style';
    let el = document.getElementById(id);
    if (blurOn && !el) {
      el = document.createElement('style');
      el.id = id;
      el.textContent = `
        .ytp-caption-segment{filter:blur(6px);transition:filter .12s}
        .ytp-caption-window-container:hover .ytp-caption-segment,
        .ytp-caption-segment:hover{filter:none}
      `;
      document.documentElement.appendChild(el);
    } else if (!blurOn && el) {
      el.remove();
    }
  }

  // 面板单独一层，铺满视口（放在播放器里会被 YouTube 的点击层挡住/点到别处）
  function ensurePanelHost() {
    if (!panelHost) {
      panelHost = document.createElement('div');
      panelHost.id = 'zs-panel-root';
      panelHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      panelShadow = panelHost.attachShadow({ mode: 'open' });
      const st = document.createElement('style');
      st.textContent = STYLE;
      panelShadow.appendChild(st);
    }
    const parent = document.fullscreenElement || document.body;
    if (panelHost.parentNode !== parent) parent.appendChild(panelHost);
    return panelShadow;
  }

  function ensureHost() {
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player) return null;
    if (host && host.isConnected && host.parentNode === player) return host;
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'zs-lite-root';
    host.style.position = 'absolute';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '9999';
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = STYLE;
    shadow.appendChild(st);
    bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.pointerEvents = 'auto';
    shadow.appendChild(bar);
    player.appendChild(host);
    try { document.documentElement.setAttribute('data-zs-lite', 'ready'); } catch (e) {}
    return host;
  }

  // ---- 字幕读取 ----
  function readCaption() {
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (!segs.length) return '';
    let txt = '';
    segs.forEach(s => {
      const t = (s.textContent || s.innerText || '').trim();
      // 过滤 YouTube 的“英语·点击查看设置”这类提示片段
      if (!t || /(点击|click).*(设置|settings)/i.test(t)) return;
      txt += (txt ? ' ' : '') + t;
    });
    return txt.replace(/\s+/g, ' ').trim();
  }

  // ---- 字幕轨（不依赖 YouTube 的 CC 开关）----
  function videoId() {
    try { return new URLSearchParams(location.search).get('v') || ''; } catch (e) { return ''; }
  }

  function bracketJson(src, key) {
    const i = src.indexOf('"' + key + '":');
    if (i < 0) return null;
    let j = src.indexOf('[', i);
    if (j < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let k = j; k < src.length; k++) {
      const c = src[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) return src.slice(j, k + 1); }
      }
    }
    return null;
  }

  function pickTrack(tracks) {
    const pref = ['en', 'en-US', 'en-GB'];
    let t = tracks.find(x => pref.includes(x.languageCode) && x.kind !== 'asr');
    if (!t) t = tracks.find(x => x.languageCode === 'en');
    if (!t) t = tracks.find(x => (x.languageCode || '').indexOf('en') === 0);
    if (!t) t = tracks.find(x => x.kind === 'asr');
    return t || tracks[0];
  }

  // 中文字幕：按当前播放位置懒加载，一次翻 30 句，翻过的不重复
  const zhMapByText = new Map();
  let zhFetching = false;
  function currentZh(text) { return zhMapByText.get(text) || ''; }
  function currentCueIndex(t) {
    if (!cues.length) return 0;
    for (let i = 0; i < cues.length; i++) if (t >= cues[i].start && t < cues[i].end) return i;
    return Math.max(0, cues.findIndex(c => c.start > t));
  }
  let zhRetryTimer = null;
  function setZhHint(text) {
    if (!bar) return;
    const zhLine = bar.querySelector('#zs-zh');
    if (!zhLine) return;
    zhLine.textContent = text || '';
    zhLine.style.display = text ? 'block' : 'none';
  }
  async function ensureZhForCues(idx) {
    if (subMode !== 'both' || zhFetching || !cues.length) return;
    const from = Math.max(0, idx || 0);
    const batch = zhMapByText.size === 0 ? 4 : 12;   // 首批少量，先让首屏出中文
    const part = cues.slice(from, from + batch).filter(c => !zhMapByText.has(c.text));
    if (!part.length) return;
    zhFetching = true;
    if (lastCaption && !currentZh(lastCaption)) setZhHint('翻译中…');
    try {
      const d = await gwT('/api/subtitle_zh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: part.map(c => c.text) })
      }, 95000);
      const arr = (d && d.lines) || [];
      part.forEach((c, j) => { if (arr[j]) zhMapByText.set(c.text, arr[j]); });
    } catch (e) {
      if (zhRetryTimer) clearTimeout(zhRetryTimer);
      zhRetryTimer = setTimeout(() => { zhRetryTimer = null; ensureZhForCues(idx); }, 5000);
    } finally { zhFetching = false; }
    if (lastCaption) {
      const z = currentZh(lastCaption);
      renderLine(lastCaption, subMode === 'both' ? z : '');
      if (!z && bar) { const el = bar.querySelector('#zs-zh'); if (el && !el.textContent) el.style.display = 'none'; }
    }
  }

  // 时间轴归一化：补足过短时长、把 <1.2s 的空隙并到下一句，避免字幕闪
  function normalizeCues(list) {
    if (!list || !list.length) return list || [];
    list.sort(function (a, b) { return a.start - b.start; });
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!isFinite(c.start)) c.start = 0;
      var end = c.end;
      if (!isFinite(end) || end - c.start < 0.5) end = c.start + 0.8;
      var next = list[i + 1];
      if (next && next.start > c.start && next.start - end < 1.2) end = next.start;
      c.end = end;
    }
    return list;
  }

  // 从 MAIN world 截获的字幕地址（带 pot）直接拿 cues：关掉 CC 也能继续用
  function fetchCuesFromUrl(url) {
    // 页面原地址可能是 YouTube 自动翻译的中文轨；优先改回英文轨
    const en = url.replace(/([?&])lang=[^&]*/, '$1lang=en').replace(/&tlang=[^&]*/g, '');
    const cands = (en !== url) ? [en, url] : [url];
    function attempt(i) {
      if (i >= cands.length) return Promise.reject(new Error('all failed'));
      const u = cands[i] + (cands[i].indexOf('fmt=') < 0 ? '&fmt=json3' : '');
      return fetch(u, { credentials: 'include' }).then(r => {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(data => {
        const events = (data && data.events) || [];
        const out = [];
        events.forEach(ev => {
          if (!ev.segs) return;
          const txt = ev.segs.map(x => x.utf8 || '').join('').replace(/\n/g, ' ').trim();
          if (!txt) return;
          const st = (ev.tStartMs || 0) / 1000;
          out.push({ start: st, end: st + (ev.dDurationMs || 2000) / 1000, text: txt });
        });
        if (!out.length) throw new Error('empty');
        return out;
      }).catch(() => attempt(i + 1));
    }
    return attempt(0);
  }

  window.addEventListener('message', function (ev) {
    const d = ev.data || {};
    const url = d.__zs_timedtext__;
    if (!url) return;
    const vid = videoId();
    if (capturedTimedtextFor === vid) return;
    capturedTimedtextFor = vid;
    fetchCuesFromUrl(url).then(list => {
      if (!list || !list.length) return;
      cues = normalizeCues(list);
      if (subMode === 'both') ensureZhForCues(0);
      trackReady = true;
      lastCaption = '';
      updateCaption();
    }).catch(function () {});
  }, false);

  async function loadTrack() {
    const vid = videoId();
    if (!vid) return;
    if (vid === curVideoId && cues.length) return;
    curVideoId = vid; cues = []; trackReady = false; trackLang = '';
    try {
      if (bar) bar.classList.remove('on');
      const r = await fetch(location.origin + '/watch?v=' + encodeURIComponent(vid), { credentials: 'include', cache: 'no-store' });
      const html = await r.text();
      const arr = bracketJson(html, 'captionTracks');
      if (!arr) { trackReady = true; return; }
      const tracks = JSON.parse(arr);
      if (!tracks || !tracks.length) { trackReady = true; return; }
      const t = pickTrack(tracks);
      trackLang = t.languageCode + (t.kind === 'asr' ? ' · 自动' : '');
      const url = t.baseUrl + (t.baseUrl.indexOf('fmt=') < 0 ? '&fmt=json3' : '');
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      const events = (data && data.events) || [];
      const out = [];
      events.forEach(ev => {
        if (!ev.segs) return;
        const txt = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
        if (!txt || /^\[.*\]$/.test(txt)) return;
        const start = (ev.tStartMs || 0) / 1000;
        out.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text: txt });
      });
      cues = normalizeCues(out);
      if (subMode === 'both') ensureZhForCues(0);
      trackReady = true;
      if (cues.length) updateCaption();
    } catch (e) {
      trackReady = true;
    }
  }

  function cueAt(t) {
    if (!cues.length) return null;
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start) hi = mid - 1;
      else if (t >= c.end) lo = mid + 1;
      else return c;
    }
    return null;
  }

  const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','at','for','with','is','are','was','were','be','been','it','this','that','these','those','i','you','he','she','they','we','me','him','her','them','us','my','your','his','its','our','their','as','by','from','so','if','then','than','too','very','can','could','will','would','should','do','does','did','not','no','yes','up','out','about','into','just','have','has','had','there','here','what','when','where','who','how','why','all','any','some','one','two','get','got','go','going','like','know','think','say','said']);

  function ensureBarSkeleton() {
    if (!bar || bar.querySelector('#zs-line')) return;
    bar.innerHTML = '';
    const drag = document.createElement('div');
    drag.className = 'dragbar';
    drag.innerHTML = '<span class="grip">⠿</span><span>拖动字幕条</span>';
    const line = document.createElement('div');
    line.className = 'line';
    line.id = 'zs-line';
    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.id = 'zs-tools';
    bar.appendChild(drag);
    bar.appendChild(line);
    const zhLine = document.createElement('div');
    zhLine.id = 'zs-zh';
    zhLine.style.cssText = 'display:none;margin-top:4px;font-size:13.5px;line-height:1.4;color:#d7dbe2;text-align:center;padding:0 4px';
    bar.appendChild(zhLine);
    bar.appendChild(tools);
    barDragHandle = drag;
  }

  function renderLine(text, zh) {
    if (!bar) return;
    ensureBarSkeleton();
    if (!text) { bar.classList.remove('on'); return; }
    // 没显式传中文时，自动按当前模式取已翻译的中文行。
    // （YouTube 原生字幕的 MutationObserver 会高频调用 renderLine(t)，
    //   若不补这一行，就会把刚写入的中文行又清成 display:none）
    if (zh === undefined) zh = subMode === 'both' ? currentZh(text) : '';
    bar.classList.add('on');
    const line = bar.querySelector('#zs-line');
    const zhLine = bar.querySelector('#zs-zh');
    if (zhLine) { zhLine.textContent = zh || ''; zhLine.style.display = zh ? 'block' : 'none'; }
    line.innerHTML = '';
    text.split(/(\s+)/).forEach(tok => {
      if (!tok.trim()) { line.appendChild(document.createTextNode(tok)); return; }
      const bare = tok.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '').toLowerCase();
      const sp = document.createElement('span');
      sp.className = 'w' + (bare && savedLemmas.has(bare) ? ' saved' : '');
      sp.textContent = tok;
      sp.dataset.w = bare;
      sp.tabIndex = 0;
      sp.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!bare) return;
        lookup(bare, text, ev.clientX, ev.clientY);
      });
      line.appendChild(sp);
    });
    const tools = bar.querySelector('#zs-tools');
    tools.innerHTML = '';
    // 暂停 / 继续（放在工具条第一位）
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'zs-pause';
    pauseBtn.title = '暂停 / 继续播放（YouTube 里按空格也行）';
    pauseBtn.onclick = () => {
      const v = document.querySelector('video');
      if (!v) return;
      if (v.paused) { v.play().catch(() => {}); }
      else { v.pause(); pausedByUs = false; }
      setTimeout(updatePauseBtn, 60);
    };
    tools.appendChild(pauseBtn);
    updatePauseBtn();
    const trBtn = document.createElement('button');
    trBtn.textContent = '翻译整句';
    const trOut = document.createElement('span');
    trOut.className = 'tr';
    trBtn.onclick = () => {
      if (trOut.dataset.done === text) return;
      trOut.textContent = '翻译中…';
      gw('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sentence: text }) })
        .then(d => { trOut.textContent = d.translation + (d.note ? '　· ' + d.note : ''); trOut.dataset.done = text; if (d.cached) trOut.textContent += '（缓存）'; })
        .catch(e => { trOut.textContent = '翻译失败：' + e.message; });
    };
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制句子';
    copyBtn.onclick = () => { navigator.clipboard.writeText(text).then(() => { copyBtn.textContent = '已复制'; setTimeout(() => copyBtn.textContent = '复制句子', 1200); }); };
    const saveSent = document.createElement('button');
    saveSent.textContent = '收藏句子';
    saveSent.onclick = () => {
      saveSent.disabled = true; saveSent.textContent = '收藏中…';
      gw('/api/sentences/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, url: location.href, video: (document.title || '').replace(/\s*-\s*YouTube\s*$/, ''), auto_translate: true })
      }).then(() => { saveSent.textContent = '已收藏 ✓'; })
        .catch(e => { saveSent.disabled = false; saveSent.textContent = '收藏失败'; });
    };
    const hide = document.createElement('button');
    hide.textContent = '隐藏';
    hide.onclick = () => bar.classList.remove('on');
    const modeBtn = document.createElement('button');
    modeBtn.id = 'zs-mode';
    modeBtn.textContent = subMode === 'both' ? '中英' : '英文';
    modeBtn.title = '切换：纯英文 / 英语+中文字幕';
    modeBtn.onclick = () => {
      subMode = subMode === 'both' ? 'en' : 'both';
      try { localStorage.setItem('zs_sub_mode', subMode); } catch (e) {}
      modeBtn.textContent = subMode === 'both' ? '中英' : '英文';
      if (subMode === 'both') { const v = document.querySelector('video'); ensureZhForCues(currentCueIndex(v ? v.currentTime : 0)); }
      if (lastCaption) renderLine(lastCaption, subMode === 'both' ? currentZh(lastCaption) : '');
    };
    tools.appendChild(modeBtn);
    tools.appendChild(trBtn); tools.appendChild(trOut); tools.appendChild(copyBtn); tools.appendChild(saveSent);
    const spacer = document.createElement('span'); spacer.className = 'sp'; tools.appendChild(spacer); tools.appendChild(hide);
    layoutBar();
  }

  // 同步暂停按钮的文案与图标（空格/面板操作也会改变播放状态）
  function updatePauseBtn() {
    if (!bar) return;
    const btn = bar.querySelector('#zs-pause');
    if (!btn) return;
    const v = document.querySelector('video');
    const paused = !v || v.paused;
    const label = paused ? '▶ 继续' : '⏸ 暂停';
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle('paused-state', paused);
  }

  // ---- 词条面板：先查本地词典（0 token），AI 详解按需点 ----
  let pausedByUs = false;

  function pauseForLookup() {
    const v = document.querySelector('video');
    if (!v) return;
    if (pauseOnWord && !v.paused) {
      try { v.pause(); pausedByUs = true; } catch (e) {}
    }
  }

  function lookup(word, sentence, x, y) {
    pauseForLookup();
    closePanel(false);
    const p = document.createElement('div');
    p.className = 'panel';
    p.innerHTML = '<button class="close">✕</button><div class="load" data-drag="1">查词中…</div>';
    panel = p;
    ensurePanelHost().appendChild(p);
    position(p, x, y);
    p.querySelector('.close').onclick = () => closePanel();
    gw('/api/dict?word=' + encodeURIComponent(word))
      .then(d => {
        if (panel !== p) return;
        renderDictPanel(p, d, word, sentence);
        // 本地词典也要记查词历史（服务端 60 秒内同词去重）
        gw('/api/lookup-log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            word: word,
            lemma: (d && d.word) || word,
            sentence: sentence,
            url: location.href,
            video: (document.title || '').replace(/\s*-\s*YouTube\s*$/, '')
          })
        }).catch(() => {});
      })
      .catch(() => { if (panel !== p) return; renderDictPanel(p, { found: false }, word, sentence); });
  }

  function renderDictPanel(p, d, word, sentence) {
    const s = v => esc(v == null ? '' : String(v));
    const videoTitle = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '');
    let html;
    if (d && d.found) {
      const trans = s(d.translation || '').replace(/；/g, '<br>');
      const meta = [
        d.collins ? ('柯林斯 ' + d.collins + ' 星') : '',
        d.oxford ? '牛津核心词' : '',
        d.bnc ? ('BNC #' + d.bnc) : '',
        d.frq ? ('词频 #' + d.frq) : '',
        d.tag ? ('标签 ' + s(d.tag)) : ''
      ].filter(Boolean).join(' · ');
      html = `<div class="phead" data-drag="1">
          <h3>${s(d.word || word)}</h3>
          <div class="ph">${s(d.phonetic || '')} <button class="spk" style="border:none;background:none;cursor:pointer;font-size:14px">🔊</button></div>
        </div>
        <div class="sec"><div class="k">释义</div><div class="txt">${trans || '—'}</div></div>
        ${meta ? `<div class="sec"><div class="k">词典信息</div><div class="txt" style="color:#6b7280">${meta}</div></div>` : ''}
        ${sentence ? `<div class="sec"><div class="k">原句</div><div class="txt" style="color:#8b93a5">${s(sentence)}</div></div>` : ''}
        <div class="acts">
          <button class="pri save">保存到生词库</button>
          <button class="ai">AI 详解（要 token）</button>
          <button class="resume">▶ 继续播放</button>
        </div>
        <div style="font-size:11px;color:#9aa1ad;margin-top:8px">本地词库 · 0 token${d.source && d.source !== 'exact' ? ' · ' + s(d.source) : ''}</div>`;
    } else {
      html = `<div class="phead" data-drag="1"><h3>${s(word)}</h3></div>
        <div class="sec"><div class="k">本地词库</div><div class="txt">没收录这个词（可能是人名或专有名词）。</div></div>
        <div class="acts"><button class="ai pri">用 AI 详解</button><button class="resume">▶ 继续播放</button></div>`;
    }
    p.innerHTML = '<button class="close">✕</button>' + html;
    p.querySelector('.close').onclick = () => closePanel();
    fitPanel(p);
    const spk = p.querySelector('.spk');
    if (spk) spk.onclick = () => speak((d && d.word) || word);
    const ai = p.querySelector('.ai');
    if (ai) ai.onclick = () => askAI(p, word, sentence);
    const save = p.querySelector('.save');
    if (save) save.onclick = () => saveWord({
      word: word,
      lemma: ((d && d.word) || word).toLowerCase(),
      phonetic: (d && d.phonetic) || '',
      meaning: (d && (d.translation || '').split('；').slice(0, 2).join('；')) || '',
      sentence: sentence,
      url: location.href,
      video: videoTitle
    }, save);
    const resume = p.querySelector('.resume');
    if (resume) resume.onclick = () => closePanel();
  }

  function askAI(p, word, sentence) {
    p.innerHTML = '<button class="close">✕</button><div class="load" data-drag="1">AI 正在分析「' + word + '」的语境…</div>';
    p.querySelector('.close').onclick = () => closePanel();
    fitPanel(p);
    const url = location.href;
    const video = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '');
    gw('/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, sentence, url, video })
    }).then(d => {
      if (panel !== p) return;
      p.innerHTML = renderExplain(d, word);
      p.querySelector('.close').onclick = () => closePanel();
      fitPanel(p);
      const spk = p.querySelector('.spk');
      if (spk) spk.onclick = () => speak(d.lemma || word);
      const save = p.querySelector('.save');
      if (save) save.onclick = () => saveWord(d, save);
      const resumeBtn = p.querySelector('.resume');
      if (resumeBtn) resumeBtn.onclick = () => closePanel();
      const tr = p.querySelector('.tr-sent');
      if (tr) tr.onclick = () => {
        tr.disabled = true; tr.textContent = '翻译中…';
        gw('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sentence }) })
          .then(r => { tr.textContent = r.translation; tr.disabled = false; })
          .catch(e => { tr.textContent = '失败：' + e.message; tr.disabled = false; });
      };
    }).catch(e => {
      if (panel !== p) return;
      p.innerHTML = '<button class="close">✕</button><div class="load" data-drag="1">出错了：' + esc(e.message) +
        '<br><br>检查本地网关是否在运行（双击 start-gateway.cmd）。</div>';
      p.querySelector('.close').onclick = () => closePanel();
    });
  }

  function renderExplain(d, word) {
    const c = d.cached ? ' <span style="font-size:11px;color:#9aa1ad">缓存</span>' : '';
    return `<button class="close">✕</button>
      <div class="phead" data-drag="1">
        <h3>${esc(d.lemma || word)} <span class="cefr">${esc(d.cefr || '')}</span>${c}</h3>
        <div class="ph">${esc(d.phonetic || '')} <button class="spk" style="border:none;background:none;cursor:pointer;font-size:14px">🔊</button></div>
      </div>
      <div class="sec"><div class="k">释义</div><div class="txt">${esc(d.meaning || '—')}</div></div>
      ${d.in_context ? `<div class="sec"><div class="k">在这句里</div><div class="txt">${esc(d.in_context)}</div></div>` : ''}
      ${d.collocations ? `<div class="sec"><div class="k">搭配</div><div class="txt">${esc(d.collocations)}</div></div>` : ''}
      ${d.example ? `<div class="sec"><div class="k">例句</div><div class="txt">${esc(d.example)}</div></div>` : ''}
      ${d.morphology ? `<div class="sec"><div class="k">词根词缀</div><div class="txt">${esc(d.morphology)}</div></div>` : ''}
      ${d.note ? `<div class="sec"><div class="k">提示</div><div class="txt">${esc(d.note)}</div></div>` : ''}
      <div class="acts">
        <button class="pri save" data-lemma="${esc((d.lemma || word).toLowerCase())}">保存到生词库</button>
        <button class="tr-sent">翻译整句</button>
        <button class="resume">▶ 继续播放</button>
      </div>`;
  }

  function saveWord(d, btn) {
    btn.disabled = true; btn.textContent = '保存中…';
    gw('/api/words/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word: d.word, lemma: d.lemma, phonetic: d.phonetic, meaning: d.meaning,
        in_context: d.in_context, collocations: d.collocations, example: d.example,
        cefr: d.cefr, note: d.note, morphology: d.morphology, sentence: d.sentence, url: location.href,
        video: (document.title || '').replace(/\s*-\s*YouTube\s*$/, '')
      })
    }).then(() => {
      savedLemmas.add((d.lemma || d.word).toLowerCase());
      btn.textContent = '已保存 ✓';
      document.querySelectorAll('.w.saved').forEach(() => {});
      renderLine(lastCaption);
    }).catch(e => { btn.disabled = false; btn.textContent = '保存失败：' + e.message; });
  }

  // ---- 拖动 / 布局：字幕条与面板都可以自由拖，首次出现按当前画面尺寸摆好 ----
  let barPosSaved = null;      // 相对播放器的比例 {rx, ry}
  let panelPosSaved = null;    // 相对视口的像素 {x, y}
  let barLaidOut = false;
  let barDragHandle = null;

  function playerBox() {
    const p = host && host.parentElement;
    if (!p) return { width: window.innerWidth, height: window.innerHeight };
    const r = p.getBoundingClientRect();
    return { width: r.width || window.innerWidth, height: r.height || window.innerHeight };
  }

  function applyBarSize() {
    if (!bar) return;
    const pb = playerBox();
    const w = Math.min(980, Math.max(300, Math.round(pb.width * 0.84)));
    bar.style.width = w + 'px';
  }

  function clampBarPos(x, y) {
    if (!bar) return;
    const pb = playerBox();
    const bw = bar.offsetWidth || 600;
    const bh = bar.offsetHeight || 90;
    x = Math.min(Math.max(4, x), Math.max(4, pb.width - bw - 4));
    y = Math.min(Math.max(4, y), Math.max(4, pb.height - bh - 4));
    bar.style.left = Math.round(x) + 'px';
    bar.style.top = Math.round(y) + 'px';
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
    bar.style.position = 'absolute';
  }

  // 首次出现：按播放器尺寸摆到下方居中（或上次拖动的位置）
  function layoutBar() {
    if (!bar) return;
    applyBarSize();
    if (barLaidOut) { const pb = playerBox(); clampBarPos(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0); return; }
    const pb = playerBox();
    const bw = bar.offsetWidth || 600;
    const bh = bar.offsetHeight || 90;
    let x = Math.round((pb.width - bw) / 2);
    let y = Math.round(pb.height - bh - Math.max(48, pb.height * 0.08));
    if (barPosSaved && isFinite(barPosSaved.rx) && isFinite(barPosSaved.ry)) {
      x = Math.round(barPosSaved.rx * pb.width);
      y = Math.round(barPosSaved.ry * pb.height);
    }
    clampBarPos(x, y);
    barLaidOut = true;
  }

  // 统一用 window 捕获阶段接管拖动：YouTube 播放器会吞掉 pointerdown，
  // 在元素上监听收不到事件，必须在 window capture 阶段拦截。
  let pendingDrag = null;

  function isInteractiveEl(t) {
    return !!(t && t.closest && t.closest('button, a, input, textarea, select'));
  }

  window.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const path = (e.composedPath && e.composedPath()) || [];
    if (bar && barDragHandle && path.indexOf(barDragHandle) >= 0) {
      pendingDrag = { kind: 'bar', el: bar, sx: e.clientX, sy: e.clientY,
        ox: parseFloat(bar.style.left) || 0, oy: parseFloat(bar.style.top) || 0 };
      bar.classList.add('dragging');
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (panel && path.indexOf(panel) >= 0 && !isInteractiveEl(e.target)) {
      const r = panel.getBoundingClientRect();
      pendingDrag = { kind: 'panel', el: panel, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      try { panel.style.userSelect = 'none'; } catch (err) {}
      panel.classList.add('dragging');
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  window.addEventListener('pointermove', e => {
    if (!pendingDrag) return;
    const dx = e.clientX - pendingDrag.sx, dy = e.clientY - pendingDrag.sy;
    if (pendingDrag.kind === 'bar') {
      clampBarPos(pendingDrag.ox + dx, pendingDrag.oy + dy);
    } else {
      const el = pendingDrag.el;
      const r = el.getBoundingClientRect();
      let x = pendingDrag.ox + dx, y = pendingDrag.oy + dy;
      x = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - r.width - 4));
      y = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - Math.min(r.height, 120) - 4));
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.round(y) + 'px';
    }
    e.preventDefault();
  }, true);

  function finishDrag() {
    if (!pendingDrag) return;
    const d = pendingDrag;
    pendingDrag = null;
    if (d.kind === 'bar') {
      bar.classList.remove('dragging');
      const pb = playerBox();
      barPosSaved = {
        rx: (parseFloat(bar.style.left) || 0) / pb.width,
        ry: (parseFloat(bar.style.top) || 0) / pb.height
      };
      try { chrome.storage.local.set({ barPos: barPosSaved }); } catch (err) {}
    } else {
      d.el.classList.remove('dragging');
      try { d.el.style.userSelect = ''; } catch (err) {}
      const r = d.el.getBoundingClientRect();
      panelPosSaved = { x: r.left, y: r.top };
      try { chrome.storage.local.set({ panelPos: panelPosSaved }); } catch (err) {}
    }
  }
  window.addEventListener('pointerup', finishDrag, true);
  window.addEventListener('pointercancel', finishDrag, true);

  function position(p, x, y) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(380, Math.max(260, vw - 24));
    p.style.width = w + 'px';
    const estH = Math.min(420, Math.round(vh * 0.62));
    let left, top;
    if (panelPosSaved && isFinite(panelPosSaved.x) && isFinite(panelPosSaved.y)) {
      left = panelPosSaved.x;
      top = panelPosSaved.y;
    } else {
      if (!isFinite(x) || !isFinite(y) || (x < 5 && y < 5)) { x = vw - w - 40; y = vh * 0.42; }
      // 优先出现在光标右侧；右边放不下放左边；都放不下就贴边
      left = Math.round(x + 24);
      if (left + w > vw - 8) left = Math.round(x - w - 24);
      if (left < 8) left = 8;
      top = Math.round(y - 80);
    }
    left = Math.min(Math.max(6, left), Math.max(6, vw - w - 6));
    top = Math.min(Math.max(6, top), Math.max(6, vh - 120));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  }

  function relayoutAll() {
    if (bar) { applyBarSize(); clampBarPos(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0); }
    if (panel) fitPanel(panel);
  }

  function fitPanel(p) {
    const r = p.getBoundingClientRect();
    let left = Math.min(Math.max(6, r.left), Math.max(6, window.innerWidth - r.width - 6));
    let top = Math.min(Math.max(6, r.top), Math.max(6, window.innerHeight - Math.min(r.height, window.innerHeight - 12) - 6));
    // 别盖住字幕条（否则面板会挡住「暂停/翻译」这些按钮）
    if (bar && bar.classList.contains('on')) {
      const br = bar.getBoundingClientRect();
      const ph = Math.min(r.height, window.innerHeight);
      const overlapX = left + r.width > br.left && left < br.right;
      const overlapY = top + ph > br.top && top < br.bottom;
      if (overlapX && overlapY) {
        const up = Math.round(br.top - ph - 10);
        if (up >= 6) {
          top = up;
          p.style.maxHeight = '';
          p.style.overflowY = '';
        } else {
          // 上方空间不够：把面板压到字幕条上方，内部滚动
          const maxH = Math.max(180, Math.round(br.top - 20));
          p.style.maxHeight = maxH + 'px';
          p.style.overflowY = 'auto';
          top = 6;
        }
      } else {
        p.style.maxHeight = '';
        p.style.overflowY = '';
      }
    }
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
  }

  function closePanel(resume) {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (resume !== false && pausedByUs) {
      const v = document.querySelector('video');
      if (v && v.paused) { try { v.play(); } catch (e) {} }
      pausedByUs = false;
    }
  }

  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-GB'; u.rate = 0.92;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- 沉浸计时 ----
  // 视频一旦继续播放，词条面板自动收起（用户要求）
  function attachPlayWatch(v) {
    if (!v || v.__zsPlayWatch) return;
    v.__zsPlayWatch = true;
    v.addEventListener('play', () => { try { closePanel(false); } catch (e) {} });
  }

  function startTick(video) {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      try {
        if (video && !video.paused && !video.ended && document.visibilityState === 'visible') {
          gw('/api/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds: 10 }) }).catch(() => {});
        }
      } catch (e) {}
    }, 10000);
  }

  // ---- 字幕监听 ----
  function watchCaptions() {
    if (observer) observer.disconnect();
    const target = document.querySelector('.ytp-caption-window-container') || document.querySelector('#movie_player');
    if (!target) return;
    let pend = null;
    observer = new MutationObserver(() => {
      if (cues.length) return;
      if (pend) return;
      pend = setTimeout(() => {
        pend = null;
        const t = readCaption();
        if (t && t !== lastCaption) { lastCaption = t; renderLine(t); }
        else if (!t && lastCaption) { lastCaption = ''; if (bar) bar.classList.remove('on'); }
      }, 120);
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // YouTube 播放器菜单（设置/画质/字幕）打开时：别去点它的按钮，也别盖住菜单
  function playerMenuOpen() {
    const sels = ['.ytp-settings-menu', '.ytp-popup.ytp-contextmenu', '.ytp-contextmenu'];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') return true;
    }
    return false;
  }

  function updateCaption() {
    if (!bar && !ensureHost()) return;
    updatePauseBtn();
    const vv = document.querySelector('video');
    if (vv) attachPlayWatch(vv);
    if (playerMenuOpen()) { if (bar) bar.classList.remove('on'); hiddenByMenu = true; return; }
    if (hiddenByMenu) { hiddenByMenu = false; if (lastCaption) renderLine(lastCaption); }
    // 优先：自己抓字幕轨（与 CC 开关无关）
    if (cues.length !== __cuesHiddenState) {
      __cuesHiddenState = cues.length;
      applyNativeHidden();
    }
    if (cues.length) {
      const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (!v) return;
      const c = cueAt(v.currentTime);
      const text = c ? c.text : '';
      if (text) lastCueShownAt = Date.now();
      if (text !== lastCaption) {
        lastCaption = text;
        if (text) {
        const zhNow = currentZh(text);
        renderLine(text, subMode === 'both' ? zhNow : '');
        if (subMode === 'both' && !zhNow) {
          const idx = cues.findIndex(c => c.text === text);
          if (idx >= 0) ensureZhForCues(idx);
        }
      }
      }
      // 句间空隙/静音时保留 1.5 秒，别一闪就没
      if (!text && bar && bar.classList.contains('on') && Date.now() - (lastCueShownAt || 0) > 1500) {
        bar.classList.remove('on');
      }
      return;
    }
    // 兜底：读 YouTube 自己的 CC 元素
    const t = readCaption();
    if (t && t !== lastCaption) { lastCaption = t; renderLine(t); }
    else if (!t && lastCaption) { lastCaption = ''; bar.classList.remove('on'); }
    // 还没有字幕：自动开一次 CC（不需要用户自己点）
    if (!t && trackReady && !cues.length) {
      autoEnableCC();
      // 试过还是没有任何字幕 → 给一次提示
      if (ccTriedFor === videoId() && ccClickedAt && Date.now() - ccClickedAt > 8000) {
        showHintOnce('这个视频没有检测到字幕轨（YouTube 里也没开 CC）。换一个带英文字幕的视频试试。', 'no-caption:' + videoId());
      }
    }
  }

  function showHintOnce(msg, key) {
    if (hintShownFor === key || !bar) return;
    hintShownFor = key;
    bar.classList.add('on');
    bar.innerHTML = '<div class="line" style="opacity:.9;font-size:14px">' + msg + '</div>' +
      '<div class="tools"><span class="sp"></span><button id="zs-hide-hint">知道了</button></div>';
    const b = bar.querySelector('#zs-hide-hint');
    if (b) b.onclick = () => bar.classList.remove('on');
  }

  // 自动打开 YouTube 的字幕开关（只针对当前视频试一次）
  function autoEnableCC() {
    const vid = videoId();
    if (!vid) return;
    if (playerMenuOpen()) return;              // 菜单开着就别动，不然会把菜单点关
    if (ccAttemptsFor === vid && ccAttempts >= 3) return;
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('aria-checked') === 'true';
    if (hideNative) {
      // 原生字幕层被我们隐藏了；CC 仅作为"取数据"的开关，保持常开
      if (!on) { btn.click(); ccAttemptsFor = vid; ccAttempts++; }
      ccTriedFor = vid;
      if (!ccClickedAt) ccClickedAt = Date.now();
      return;
    }
    if (ccTriedFor === vid) return;
    const v = document.querySelector('video');
    if (!v || v.paused) return;
    if (!on) { btn.click(); ccAttemptsFor = vid; ccAttempts++; }
    ccTriedFor = vid;
    ccClickedAt = Date.now();
  }

  function init() {
    loadSettings();
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    attachPlayWatch(v);
    ensureHost();
    watchCaptions();
    updateCaption();
    loadTrack();
    if (v) startTick(v);
    setTimeout(() => { if (!playerMenuOpen()) forceEnglishCC(); }, 2500);
    setTimeout(() => { if (!playerMenuOpen()) forceEnglishCC(); }, 7000);
    setTimeout(() => { ensureHost(); watchCaptions(); }, 1200);
    setTimeout(() => { ensureHost(); watchCaptions(); }, 4000);
  }

  // 单页应用切换
  window.addEventListener('yt-navigate-finish', () => {
    lastCaption = ''; closePanel();
    if (bar) bar.classList.remove('on');
    barLaidOut = false;
    ccAttempts = 0; ccAttemptsFor = '';
    setTimeout(init, 600);
    setTimeout(() => { if (!playerMenuOpen()) forceEnglishCC(); }, 3000);
  });
  window.addEventListener('resize', () => { try { relayoutAll(); } catch (e) {} });
  document.addEventListener('fullscreenchange', () => setTimeout(() => {
    try { if (panelHost) ensurePanelHost(); relayoutAll(); } catch (e) {}
  }, 350));
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'b' || e.key === 'B')) {
      blurOn = !blurOn; applyBlur();
      try { chrome.storage.local.set({ blur: blurOn }); } catch (err) {}
    }
  });
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'toggle-blur') {
        blurOn = !blurOn; applyBlur();
        try { chrome.storage.local.set({ blur: blurOn }); } catch (e) {}
      }
      if (msg.type === 'status') {
        sendResponse({
          ok: true, video: videoId(), cues: cues.length, trackReady: trackReady,
          ccText: readCaption().length > 0, barOn: !!(bar && bar.classList.contains('on')),
          lang: trackLang
        });
      }
    });
    chrome.storage.onChanged.addListener(ch => {
      if (ch.gateway) GATE = ch.gateway.newValue || DEF;
      if (ch.hideNative) { hideNative = ch.hideNative.newValue !== false; applyNativeHidden(); }
    });
  } catch (e) {}

  setTimeout(init, 800);
  setInterval(() => { if (!host || !host.isConnected) init(); }, 15000);
  setInterval(updateCaption, 400);
  setInterval(() => { if (videoId() !== curVideoId) { cues = []; lastCaption = ''; capturedTimedtextFor = ''; loadTrack(); } }, 3000);
})();
