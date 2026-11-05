// English Study · service worker
// 1) 代理所有本地网关请求（content script 直接 fetch 会被 CORS/混合内容拦住）
// 2) 通过 MAIN world 脚本把 YouTube 字幕轨强制切成英文
const DEF = 'http://127.0.0.1:8788';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'api') {
    (async () => {
      try {
        const base = (msg.base || DEF).replace(/\/$/, '');
        const init = { method: msg.method || 'GET', cache: 'no-store' };
        if (msg.body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(msg.body);
        }
        const r = await fetch(base + msg.path, init);
        const txt = await r.text();
        let data;
        try { data = JSON.parse(txt); } catch (e) { data = { error: txt.slice(0, 200) }; }
        sendResponse({ ok: r.ok, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'english-cc') {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) return sendResponse({ ok: false, error: 'no tab' });
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            try {
              const p = document.getElementById('movie_player');
              if (!p || typeof p.getOption !== 'function') return 'no-player';
              const list = p.getOption('captions', 'tracklist') || [];
              if (!list.length) return 'no-tracks';
              const en = list.find(t => /^en(\b|-)/i.test(t.languageCode || '')) || list.find(t => (t.vssId || '').indexOf('en') === 0);
              if (!en) return 'no-english';
              const cur = p.getOption('captions', 'track') || {};
              if (cur && cur.languageCode === en.languageCode && cur.kind === en.kind) return 'already:' + en.languageCode;
              p.setOption('captions', 'track', { languageCode: en.languageCode, kind: en.kind || '' });
              return 'set:' + en.languageCode;
            } catch (e) { return 'err:' + e.message; }
          }
        });
        sendResponse({ ok: true, result: res && res[0] && res[0].result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-blur') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'toggle-blur' }); } catch (e) {}
  }
});
