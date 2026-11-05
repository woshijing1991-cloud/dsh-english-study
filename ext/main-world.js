// MAIN world：截获 YouTube 播放器请求字幕轨的地址（里面带 PO token）
// 这样就不必依赖“打开 CC”才能拿到字幕数据。
(() => {
  'use strict';
  const TAG = '__zs_timedtext__';
  function report(url) {
    try {
      if (!url || String(url).indexOf('/api/timedtext') < 0) return;
      window.postMessage({ [TAG]: String(url) }, '*');
    } catch (e) {}
  }
  try {
    const of = window.fetch;
    if (of && !of.__zsHooked) {
      const wrapped = function (input, init) {
        try {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          if (u.indexOf('/api/timedtext') >= 0) report(u);
        } catch (e) {}
        return of.call(this, input, init);
      };
      wrapped.__zsHooked = true;
      window.fetch = wrapped;
    }
    const oo = XMLHttpRequest.prototype.open;
    if (oo && !oo.__zsHooked) {
      const wrappedOpen = function (method, url) {
        try { report(url); } catch (e) {}
        return oo.apply(this, arguments);
      };
      wrappedOpen.__zsHooked = true;
      XMLHttpRequest.prototype.open = wrappedOpen;
    }
  } catch (e) {}
})();
