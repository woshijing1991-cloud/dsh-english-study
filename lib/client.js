// lib/client.js — English Study 插件面板（React UMD，无构建）
//
// 契约与 dsh-music/lib/client.js 一致：
//   window.__ModuleLoader__.load({ id, factory:(require)=>{ ... exports.apply/inject/name ... } })
//   apply(ctx) 里第一件事注册 slots：'main' 放整页，'sidebar.panellist' 放入口图标。
// 数据全走宿主同域路由 /dsh-english-study/api/*，不直连 8788。
window.__ModuleLoader__.load({
  id: 'dsh-english-study',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var PANEL_ID = 'english-study'
    var API = '/dsh-english-study'
    // 直连网关的少数路径（YouTube feed / 缩略图 / 字幕翻译）用这个地址；
    // 默认本机 8788，宿主配置里的 gateway 会覆盖它（换端口不用改源码）
    var GATEWAY = 'http://127.0.0.1:8788'
    var TABS = [
      { key: 'dashboard', label: '看板' },
      { key: 'learn', label: '学习' },
      { key: 'words', label: '生词本' },
      { key: 'review', label: '复习' },
      { key: 'dict', label: '词典' },
      { key: 'settings', label: '设置' },
    ]
    var C = {
      card: 'light-dark(#ffffff, #1b1e26)',
      line: 'light-dark(#e6e8ee, #2c313d)',
      text: 'light-dark(#111827, #e8ecf4)',
      sub: 'light-dark(#6b7280, #99a2b3)',
      accent: 'light-dark(#4338ca, #9b9bff)',
      chip: 'light-dark(#f3f4f6, #242935)',
      warn: 'light-dark(#b45309, #f0b45a)',
      ok: 'light-dark(#047857, #4ade9b)',
    }

    async function jget(path, opts) {
      var r = await fetch(API + path, opts)
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120))
      return r.json()
    }
    function jpost(path, body) {
      return jget(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    // 任何渲染异常都显示在面板上，避免白屏（本机踩过的坑）
    class ErrBoundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(e) { return { err: e } }
      render() {
        if (this.state.err) {
          return h('div', { style: { padding: 20, color: C.warn, font: '14px/1.6 ui-sans-serif,system-ui' } },
            '面板出错：' + String((this.state.err && this.state.err.message) || this.state.err))
        }
        return this.props.children
      }
    }
    function Boundary(props) { return h(ErrBoundary, null, props.children) }

    function ZsIcon(props) {
      var s = (props && props.size) || 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z' }),
        h('path', { d: 'M4 5.5V21M9 7h7M9 11h5' }))
    }
    function SidebarIcon(props) {
      // 与 Music 的播放小圆点同款：蓝框入口上显示待复习词数
      var ds = useState(0), due = ds[0], setDue = ds[1]
      useEffect(function () {
        var alive = true
        function tick() {
          jget('/api/stats').then(function (j) {
            if (alive) setDue((j && j.totals && j.totals.due) || 0)
          }).catch(function () {})
        }
        tick()
        var t = setInterval(tick, 60000)
        return function () { alive = false; clearInterval(t) }
      }, [])
      var size = (props && props.size) || 16
      return h('span', {
        title: due ? 'English Study · 待复习 ' + due + ' 词' : 'English Study',
        style: { display: 'inline-flex', alignItems: 'center', position: 'relative' },
      },
        h(ZsIcon, { size: size }),
        due > 0 ? h('span', {
          style: {
            position: 'absolute', right: -6, top: -6, minWidth: 14, height: 14,
            borderRadius: 999, background: '#e11d48', color: '#fff',
            fontSize: 9, lineHeight: '14px', textAlign: 'center',
            padding: '0 3px', fontWeight: 700, boxSizing: 'border-box',
          },
        }, due > 99 ? '99+' : String(due)) : null)
    }

    function Card(props) {
      return h('div', {
        style: {
          background: C.card, border: '1px solid ' + C.line, borderRadius: 12,
          padding: props.pad || 14, marginBottom: 12,
        },
      }, props.children)
    }
    function SectionTitle(props) {
      return h('div', {
        style: { color: C.sub, fontSize: 12, letterSpacing: '.04em', margin: '2px 0 10px' },
      }, props.children)
    }
    function Stat(props) {
      return h('div', {
        style: {
          flex: '1 1 0', minWidth: 110, background: C.card,
          border: '1px solid ' + C.line, borderRadius: 12, padding: '12px 14px',
        },
      },
        h('div', { style: { fontSize: 11, color: C.sub } }, props.label),
        h('div', { style: { fontSize: 26, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' } }, String(props.value == null ? '—' : props.value)))
    }
    function Err(props) {
      if (!props.msg) return null
      return h('div', {
        style: { background: C.chip, color: C.warn, borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 13 },
      }, props.msg)
    }
    function Btn(props) {
      return h('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        style: {
          background: props.primary ? C.accent : C.chip,
          color: props.primary ? 'light-dark(#ffffff, #11131a)' : C.text,
          border: '1px solid ' + C.line, borderRadius: 9,
          padding: '7px 14px', fontSize: 13, cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? .6 : 1, marginRight: 8,
        },
      }, props.children)
    }

    // ---- 各 tab（分开写，避免 useState 解构写法踩 UMD 环境）----
    function DashboardTab() {
      var st = useState(null), data = st[0], setData = st[1]
      var er = useState(''), err = er[0], setErr = er[1]
      var ld = useState(true), loading = ld[0], setLoading = ld[1]
      useEffect(function () {
        var alive = true
        Promise.all([jget('/api/health'), jget('/api/stats')])
          .then(function (arr) { if (alive) { setData({ health: arr[0], stats: arr[1] }); setErr('') } })
          .catch(function (e) { if (alive) setErr('取数失败：' + e.message) })
          .finally(function () { if (alive) setLoading(false) })
        return function () { alive = false }
      }, [])
      var t = (data && data.stats && data.stats.totals) || {}
      var today = (data && data.stats && data.stats.today) || {}
      var series = (data && data.stats && data.stats.series) || []
      var top = (data && data.stats && data.stats.top) || []
      var maxW = Math.max.apply(null, series.map(function (x) { return x.words || 0 }).concat([1]))

      return h('div', null,
        h(Err, { msg: err }),
        loading ? h('div', { style: { color: C.sub, fontSize: 13 } }, '加载中…') : null,
        data ? h('div', null,
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 } },
            h(Stat, { label: '已存生词', value: t.saved }),
            h(Stat, { label: '已掌握', value: t.learned }),
            h(Stat, { label: '待复习', value: t.due }),
            h(Stat, { label: '连续天数', value: t.streak })),
          h(Card, null,
            h(SectionTitle, null, '今日'),
            h('div', { style: { color: C.text, fontSize: 14, lineHeight: 1.9 } },
              '查词 ' + (today.lookups == null ? '—' : today.lookups) + ' 次 · 不同词 ' +
              (today.distinct_words == null ? '—' : today.distinct_words) + ' 个 · 新增生词 ' +
              (today.saved == null ? '—' : today.saved) + ' 个 · 沉浸 ' +
              Math.round((today.immersion_sec || 0) / 60) + ' 分钟')),
          h(Card, null,
            h(SectionTitle, null, '近 14 天 · 每日新增生词'),
            h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 64 } },
              series.map(function (x, i) {
                var v = x.words || 0
                return h('div', {
                  key: i, title: x.day + '：' + v + ' 词',
                  style: {
                    flex: 1, height: Math.max(2, Math.round(v / maxW * 60)),
                    background: C.accent, borderRadius: '3px 3px 0 0', opacity: .85,
                  },
                })
              }))),
          h(Card, null,
            h(SectionTitle, null, '近 30 天高频查词'),
            top.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              top.map(function (x, i) {
                return h('span', {
                  key: i,
                  style: { background: C.chip, borderRadius: 999, padding: '4px 10px', fontSize: 12, color: C.text },
                }, x.lemma + ' ×' + x.n)
              })) : h('div', { style: { color: C.sub, fontSize: 13 } }, '暂无查词记录')),
          h('div', { style: { color: C.sub, fontSize: 12, marginTop: 4 } },
            '网关：' + (data.health && data.health.ok ? '在线' : '异常') +
            ' · AI：' + (data.health && data.health.ai ? data.health.model : '未启用') +
            ' · 词典：' + (data.health && data.health.dict ? '已加载' : '缺失'))
        ) : null)
    }

    function WordsTab() {
      var q = useState(''), kw = q[0], setKw = q[1]
      var li = useState([]), items = li[0], setItems = li[1]
      var er = useState(''), err = er[0], setErr = er[1]
      var ld = useState(false), loading = ld[0], setLoading = ld[1]
      var load = useCallback(function () {
        setLoading(true)
        jget('/api/words?q=' + encodeURIComponent(kw))
          .then(function (j) { setItems(j.items || []); setErr('') })
          .catch(function (e) { setErr('取数失败：' + e.message) })
          .finally(function () { setLoading(false) })
      }, [kw])
      useEffect(function () { load() }, [load])
      return h('div', null,
        h(Err, { msg: err }),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
          h('input', {
            value: kw, onChange: function (e) { setKw(e.target.value) },
            placeholder: '搜索生词…',
            style: {
              flex: 1, background: C.card, color: C.text, border: '1px solid ' + C.line,
              borderRadius: 9, padding: '8px 12px', fontSize: 13,
            },
          }),
          h(Btn, { onClick: load, primary: true }, '刷新')),
        loading ? h('div', { style: { color: C.sub, fontSize: 13 } }, '加载中…')
          : items.length ? h('div', null, items.map(function (w, i) {
            return h('div', {
              key: i,
              style: {
                display: 'flex', justifyContent: 'space-between', gap: 10,
                borderBottom: '1px solid ' + C.line, padding: '9px 2px', fontSize: 13,
              },
            },
              h('span', { style: { color: C.text, fontWeight: 600 } }, w.lemma || w.word),
              h('span', {
                style: {
                  color: C.sub, flex: 1, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, w.meaning || w.translation || ''),
              h('span', { style: { color: C.sub, fontSize: 12 } }, w.status || ''))
          })) : h('div', { style: { color: C.sub, fontSize: 13 } }, '没有生词'))
    }

    function ReviewTab() {
      var cd = useState([]), cards = cd[0], setCards = cd[1]
      var ix = useState(0), idx = ix[0], setIdx = ix[1]
      var sh = useState(false), show = sh[0], setShow = sh[1]
      var ms = useState(''), msg = ms[0], setMsg = ms[1]
      var er = useState(''), err = er[0], setErr = er[1]
      useEffect(function () {
        jget('/api/review/due')
          .then(function (j) { setCards(j.items || []); setIdx(0); setErr('') })
          .catch(function (e) { setErr('取数失败：' + e.message) })
      }, [])
      var cur = cards[idx]
      function grade(g) {
        if (!cur) return
        jpost('/api/review/grade', { id: cur.id, grade: g })
          .then(function () { setMsg(g === 'again' ? '已标记「不认识」，明天再来' : '已标记「认识」'); setShow(false); setIdx(idx + 1) })
          .catch(function (e) { setErr('评分失败：' + e.message) })
      }
      return h('div', null,
        h(Err, { msg: err }),
        msg ? h('div', { style: { color: C.ok, fontSize: 13, marginBottom: 10 } }, msg) : null,
        !cards.length ? h('div', { style: { color: C.sub, fontSize: 13 } }, '暂时没有待复习的词 🎉')
          : !cur ? h('div', { style: { color: C.sub, fontSize: 13 } }, '这一轮复习完了')
            : h(Card, { pad: 20 },
              h('div', { style: { color: C.sub, fontSize: 12 } }, (idx + 1) + ' / ' + cards.length),
              h('div', { style: { fontSize: 30, fontWeight: 700, color: C.text, margin: '10px 0 14px' } }, cur.lemma || cur.word),
              show ? h('div', { style: { color: C.text, fontSize: 15, lineHeight: 1.8, whiteSpace: 'pre-wrap' } }, cur.meaning || '（无释义）')
                : h(Btn, { onClick: function () { setShow(true) } }, '显示答案'),
              h('div', { style: { marginTop: 16, display: 'flex', gap: 8 } },
                h(Btn, { onClick: function () { grade('good') }, primary: true, disabled: !show }, '认识'),
                h(Btn, { onClick: function () { grade('again') }, disabled: !show }, '不认识'))))
    }

    function DictTab() {
      var w = useState(''), word = w[0], setWord = w[1]
      var rs = useState(null), res = rs[0], setRes = rs[1]
      var er = useState(''), err = er[0], setErr = er[1]
      function lookup() {
        var q = String(word || '').trim()
        if (!q) return
        jget('/api/dict?word=' + encodeURIComponent(q))
          .then(function (j) { setRes(j); setErr('') })
          .catch(function (e) { setErr('查词失败：' + e.message) })
      }
      var defs = res && res.definition ? String(res.definition).split(/\s*\|\s*/) : []
      return h('div', null,
        h(Err, { msg: err }),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
          h('input', {
            value: word, onChange: function (e) { setWord(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') lookup() },
            placeholder: '输入英文单词…',
            style: {
              flex: 1, background: C.card, color: C.text, border: '1px solid ' + C.line,
              borderRadius: 9, padding: '8px 12px', fontSize: 13,
            },
          }),
          h(Btn, { onClick: lookup, primary: true }, '查词')),
        res ? h(Card, { pad: 18 },
          h('div', { style: { fontSize: 26, fontWeight: 700, color: C.text } },
            res.word || word, h('span', { style: { fontSize: 14, fontWeight: 400, color: C.sub, marginLeft: 10 } }, res.phonetic || '')),
          res.found ? h('div', null,
            h('div', { style: { color: C.text, fontSize: 15, lineHeight: 1.9, marginTop: 8, whiteSpace: 'pre-wrap' } }, res.translation || '（无中文释义）'),
            defs.length ? h('div', { style: { marginTop: 10 } },
              h(SectionTitle, null, '英文释义'),
              defs.map(function (d, i) {
                return h('div', { key: i, style: { color: C.sub, fontSize: 13, lineHeight: 1.7 } }, (i + 1) + '. ' + d)
              })) : null,
            h('div', { style: { color: C.sub, fontSize: 11, marginTop: 10 } }, res.source || '')) : h('div', { style: { color: C.warn, fontSize: 14 } }, '词典未收录'))
          : null)
    }

    function SettingsTab() {
      var hs = useState(null), health = hs[0], setHealth = hs[1]
      var er = useState(''), err = er[0], setErr = er[1]
      useEffect(function () {
        jget('/api/health').then(setHealth).catch(function (e) { setErr('网关不可达：' + e.message) })
      }, [])
      return h('div', null,
        h(Err, { msg: err }),
        h(Card, null,
          h(SectionTitle, null, '数据网关'),
          h('div', { style: { color: C.text, fontSize: 14, lineHeight: 2, whiteSpace: 'pre-line' } },
            '状态：' + (health && health.ok ? '在线' : '未连接') + '\n' +
            'AI 模型：' + ((health && health.model) || '—') + '\n' +
            '词典：' + (health && health.dict ? '已加载' : '缺失') + '\n' +
            '端口：' + ((health && health.port) || 8788)),
          h('div', { style: { color: C.sub, fontSize: 12, marginTop: 8 } },
            '面板通过 /dsh-english-study/api/* 与网关通信（同源代理）。')),
        h(Card, null,
          h(SectionTitle, null, '独立看板'),
          h('div', { style: { color: C.sub, fontSize: 13, lineHeight: 1.8 } },
            '看板已收编为插件内的「看板」标签页；桌面上的 English Study 看板.url 已停用，不再作为独立模块。')))
    }

    // 面板内刷 YouTube：InnerTube 拉「首页 feed / 搜索」→ 自己渲染成网格 → 点卡片用官方 /embed/ 在线播
    // 视频不下载；缩略图走网关代理（面板在国内直连 i.ytimg.com 会裂图）
    var playerFrame = null

    function parseVid(raw) {
      var s = String(raw || '').trim()
      var m = s.match(/(?:[?&]v=|\/embed\/|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)
      if (m) return m[1]
      if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
      return ''
    }

    function LearnTab() {
      var vS = useState('home'), view = vS[0], setView = vS[1]
      var hS = useState(null), diag = hS[0], setDiag = hS[1]
      useEffect(function () {
        jget('/api/health').then(setDiag).catch(function () { setDiag(null) })
      }, [])
      var itS = useState([]), items = itS[0], setItems = itS[1]
      var qS = useState(''), q = qS[0], setQ = qS[1]
      var csS = useState(''), cursor = csS[0], setCursor = csS[1]
      var srcS = useState('home'), source = srcS[0], setSource = srcS[1]
      var ldS = useState(false), loading = ldS[0], setLoading = ldS[1]
      var erS = useState(''), err = erS[0], setErr = erS[1]
      var sdS = useState(''), seed = sdS[0], setSeed = sdS[1]
      var lgS = useState(null), login = lgS[0], setLogin = lgS[1]
      var rcS = useState([]), recent = rcS[0], setRecent = rcS[1]
      var vdS = useState(''), vid = vdS[0], setVid = vdS[1]
      var vtS = useState(''), vtitle = vtS[0], setVtitle = vtS[1]
      var cuS = useState([]), cues = cuS[0], setCues = cuS[1]
      var clS = useState(false), cueLoading = clS[0], setCueLoading = clS[1]
      var tS = useState(0), curT = tS[0], setCurT = tS[1]
      var mdS = useState('both'), mode = mdS[0], setMode = mdS[1]
      var zhS = useState({}), zhMap = zhS[0], setZhMap = zhS[1]
      var dtS = useState(null), dict = dtS[0], setDict = dtS[1]

      function api(path, opt) {
        return fetch(GATEWAY + path, opt).then(function (r) { return r.json() })
      }
      function loadHome(sd) {
        var useSeed = sd || seed || String(Date.now() % 1000000)
        setLoading(true); setErr(''); setSource('home')
        api('/api/yt/home?seed=' + encodeURIComponent(useSeed))
          .then(function (j) {
            if (!j.ok) throw new Error(j.error || '首页加载失败')
            setItems(j.items || []); setCursor('')
            setLogin({ logged: !!j.logged })
          })
          .catch(function (e) { setErr('首页加载失败：' + e.message) })
          .finally(function () { setLoading(false) })
      }
      function doSearch(term) {
        var t = String(term || q || '').trim()
        if (!t) return
        setLoading(true); setErr(''); setSource('search'); setQ(t)
        api('/api/yt/search?q=' + encodeURIComponent(t))
          .then(function (j) {
            if (!j.ok) throw new Error(j.error || '搜索失败')
            setItems(j.items || []); setCursor(j.cursor || '')
          })
          .catch(function (e) { setErr('搜索失败：' + e.message) })
          .finally(function () { setLoading(false) })
      }
      function more() {
        if (!cursor) return
        setLoading(true)
        var url = source === 'search'
          ? '/api/yt/search?q=' + encodeURIComponent(q) + '&cursor=' + encodeURIComponent(cursor)
          : '/api/yt/home?cursor=' + encodeURIComponent(cursor)
        api(url).then(function (j) {
          if (!j.ok) throw new Error(j.error || '加载失败')
          var ids = {}
          items.forEach(function (x) { ids[x.id] = 1 })
          setItems(items.concat((j.items || []).filter(function (x) { return !ids[x.id] })))
          setCursor(j.cursor || '')
        }).catch(function (e) { setErr('加载更多失败：' + e.message) })
          .finally(function () { setLoading(false) })
      }
      function loadRecent() {
        api('/api/yt/recent').then(function (j) { if (j.ok) setRecent(j.items || []) }).catch(function () {})
      }
      function loadLogin() {
        api('/api/yt/login').then(function (j) { setLogin(j) }).catch(function () {})
      }
      function tryLogin() {
        setLoading(true); setErr('')
        api('/api/yt/login?action=extract').then(function (j) {
          setLogin(j)
          if (!j.logged) {
            setErr('没读到登录态：浏览器开着时 Cookie 库是独占锁。请先退出 Edge，再点「读取登录态」；或者直接用下面的主题推荐/搜索。')
          } else {
            loadHome(seed)
          }
        }).catch(function (e) { setErr('读取登录态失败：' + e.message) })
          .finally(function () { setLoading(false) })
      }
      function loadCues(id) {
        setCueLoading(true); setErr('')
        api('/api/yt/cues?video=' + encodeURIComponent(id))
          .then(function (j) {
            if (!j.ok) throw new Error(j.error || '取字幕失败')
            setCues(j.cues || [])
          })
          .catch(function (e) { setErr('取字幕失败：' + e.message + '（视频仍可正常播放）') })
          .finally(function () { setCueLoading(false) })
      }
      function openVideo(it) {
        setVid(it.id); setVtitle(it.title || ''); setView('watch')
        setCues([]); setDict(null); setZhMap({}); setCurT(0)
        loadCues(it.id)
      }
      function openExternal() {
        jpost('/api/learn/open', { url: 'https://www.youtube.com/watch?v=' + vid })
          .then(function (j) { setErr('已在独立浏览器打开：' + j.url) })
          .catch(function (e) { setErr('打开失败：' + e.message) })
      }

      useEffect(function () {
        function onMessage(e) {
          var o = e.origin || ''
          if (o.indexOf('youtube.com') < 0 && o.indexOf('youtube-nocookie.com') < 0) return
          var d = e.data
          if (typeof d === 'string') { try { d = JSON.parse(d) } catch (x) { return } }
          if (!d || typeof d !== 'object') return
          var info = d.info || {}
          var t = (typeof info.currentTime === 'number') ? info.currentTime : d.currentTime
          if ((d.event === 'infoDelivery' || d.event === 'initialDelivery') && typeof t === 'number') {
            setCurT(t)
          }
        }
        window.addEventListener('message', onMessage)
        return function () { window.removeEventListener('message', onMessage) }
      }, [])

      function onFrameLoad() {
        try {
          if (playerFrame && playerFrame.contentWindow) {
            playerFrame.contentWindow.postMessage(
              JSON.stringify({ event: 'listening', id: 'zs1', channel: 'widget' }), '*')
          }
        } catch (e) {}
      }
      function postCmd(func, args) {
        try {
          if (playerFrame && playerFrame.contentWindow) {
            playerFrame.contentWindow.postMessage(JSON.stringify({
              event: 'command', func: func, args: args || [], id: 'zs1', channel: 'widget',
            }), '*')
          }
        } catch (e) {}
      }
      function seek(t) { postCmd('seekTo', [t, true]); postCmd('playVideo'); setCurT(t) }

      function ensureZhAround(idx) {
        if (mode !== 'both' || !cues.length || idx < 0) return
        var from = Math.max(0, idx - 2), to = Math.min(cues.length, idx + 14)
        var part = [], keys = [], i
        for (i = from; i < to; i++) {
          var t = cues[i].text
          if (!zhMap[t]) { part.push(t); keys.push(t) }
        }
        if (!part.length) return
        fetch(GATEWAY + '/api/subtitle_zh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: part }),
        }).then(function (r) { return r.json() }).then(function (j) {
          var arr = j.lines || [], next = {}, n
          for (n in zhMap) next[n] = zhMap[n]
          for (n = 0; n < arr.length && n < keys.length; n++) if (arr[n]) next[keys[n]] = arr[n]
          setZhMap(next)
        }).catch(function () {})
      }

      var active = -1, idx
      for (idx = 0; idx < cues.length; idx++) {
        if (curT >= cues[idx].start - 0.25 && curT < cues[idx].end + 0.4) { active = idx; break }
      }
      if (active < 0) {
        for (idx = 0; idx < cues.length; idx++) if (cues[idx].start > curT) { active = idx; break }
      }
      useEffect(function () { ensureZhAround(active) }, [active, mode, cues.length])
      useEffect(function () { loadHome(String(Date.now() % 1000000)); loadLogin(); loadRecent() }, [])

      function lookupWord(w, sentence) {
        jget('/api/dict?word=' + encodeURIComponent(w))
          .then(function (j) { setDict({ word: w, sentence: sentence || '', data: j }) })
          .catch(function (e) { setErr('查词失败：' + e.message) })
      }
      function saveWord() {
        if (!dict) return
        jpost('/api/words/add', {
          word: dict.word,
          meaning: (dict.data && dict.data.translation) || '',
          sentence: dict.sentence,
        }).then(function () { setErr('已保存「' + dict.word + '」到生词本') })
          .catch(function (e) { setErr('保存失败：' + e.message) })
      }

      function card(it) {
        return h('div', {
          key: it.id,
          onClick: function () { openVideo(it) },
          style: { cursor: 'pointer', minWidth: 0 },
        },
          h('div', {
            style: {
              position: 'relative', borderRadius: 10, overflow: 'hidden',
              background: '#000', aspectRatio: '16 / 9',
            },
          },
            h('img', {
              src: GATEWAY + '/api/yt/thumb?id=' + it.id,
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            }),
            it.length ? h('span', {
              style: {
                position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,.82)',
                color: '#fff', fontSize: 11, padding: '1px 5px', borderRadius: 4,
              },
            }, it.length) : null),
          h('div', {
            style: {
              color: C.text, fontSize: 13, fontWeight: 600, lineHeight: 1.4, marginTop: 8,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            },
          }, it.title || it.id),
          h('div', { style: { color: C.sub, fontSize: 12, marginTop: 4 } },
            [it.channel, it.views, it.published].filter(Boolean).join(' · ') || ' '))
      }

      function wordsRow(c, i) {
        var on = i === active
        var toks = String(c.text || '').split(/(\s+)/)
        return h('div', {
          key: i,
          onClick: function () { seek(c.start) },
          style: {
            padding: '7px 10px', marginBottom: 4, cursor: 'pointer',
            borderLeft: on ? '3px solid ' + C.accent : '3px solid transparent',
            background: on ? C.chip : 'transparent', borderRadius: 6,
          },
        },
          h('span', {
            style: { color: C.sub, fontSize: 11, marginRight: 8, fontVariantNumeric: 'tabular-nums' },
          }, String(Math.floor(c.start / 60)) + ':' + String(Math.floor(c.start % 60)).padStart(2, '0')),
          h('span', { style: { color: C.text, fontSize: 14, lineHeight: 1.7 } },
            toks.map(function (tok, j2) {
              if (!tok.trim()) return h('span', { key: j2 }, tok)
              var bare = tok.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '').toLowerCase()
              return h('span', {
                key: j2,
                onClick: bare ? function (ev) { ev.stopPropagation(); lookupWord(bare, c.text) } : null,
                style: {
                  cursor: bare ? 'pointer' : 'default',
                  borderBottom: bare ? '1px dotted ' + C.line : 'none',
                },
              }, tok)
            })),
          mode === 'both' && zhMap[c.text]
            ? h('div', { style: { color: C.sub, fontSize: 13, lineHeight: 1.6, marginTop: 2 } }, zhMap[c.text])
            : null)
      }

      if (view === 'watch') {
        return h('div', null,
          h(Err, { msg: err }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            h(Btn, { onClick: function () { setView('home') } }, '← 返回'),
            h('div', {
              style: {
                color: C.text, fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, vtitle || vid),
            h(Btn, { onClick: openExternal }, '改用浏览器打开')),
          h(Card, { pad: 0 },
            h('iframe', {
              key: vid,
              ref: function (el) { playerFrame = el },
              onLoad: onFrameLoad,
              src: 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&cc_load_policy=0' +
                '&origin=' + encodeURIComponent(location.origin),
              width: '100%', height: 400, frameBorder: '0',
              allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
              allowFullScreen: true,
              style: { display: 'block', border: 'none', borderRadius: '12px 12px 0 0', background: '#000' },
            }),
            h('div', { style: { padding: '8px 12px 12px', color: C.sub, fontSize: 11, lineHeight: 1.6 } },
              '若播放器空白/提示无法播放：该 UP 主禁止嵌入 → 点「改用浏览器打开」。')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
            h(Btn, { onClick: function () { setMode(mode === 'both' ? 'en' : 'both') } },
              mode === 'both' ? '中英' : '英文'),
            h('span', { style: { color: C.sub, fontSize: 12 } },
              cueLoading ? '抓字幕中…' : (cues.length ? cues.length + ' 句 · ' + Math.floor(curT) + 's' : '无字幕'))),
          cues.length ? h(Card, { pad: 10 },
            h(SectionTitle, null, '字幕 · 点单词查词，点整行跳转'),
            h('div', { style: { maxHeight: 420, overflowY: 'auto' } },
              cues.map(function (c, i) { return wordsRow(c, i) }))) : null,
          dict ? h(Card, { pad: 16 },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
              h('span', { style: { fontSize: 22, fontWeight: 700, color: C.text } }, dict.word),
              h('span', { style: { color: C.sub, fontSize: 14 } }, (dict.data && dict.data.phonetic) || '')),
            dict.data && dict.data.found
              ? h('div', null,
                h('div', {
                  style: { color: C.text, fontSize: 14, lineHeight: 1.8, marginTop: 8, whiteSpace: 'pre-wrap' },
                }, dict.data.translation || '（无中文释义）'),
                dict.data.definition
                  ? h('div', { style: { color: C.sub, fontSize: 13, lineHeight: 1.7, marginTop: 6 } },
                    String(dict.data.definition).split(/\s*\|\s*/).slice(0, 2).join(' · ')) : null)
              : h('div', { style: { color: C.warn, fontSize: 13 } }, '词典未收录'),
            h('div', { style: { marginTop: 12 } },
              h(Btn, { onClick: saveWord, primary: true }, '保存生词'),
              h(Btn, { onClick: function () { setDict(null) } }, '关闭'))) : null)
      }

      return h('div', null,
        h(Err, { msg: err }),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
          h('input', {
            value: q, onChange: function (e) { setQ(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') doSearch(q) },
            placeholder: '搜索 YouTube 视频…（回车搜索，点封面直接看）',
            style: {
              flex: 1, minWidth: 200, background: C.card, color: C.text,
              border: '1px solid ' + C.line, borderRadius: 999, padding: '9px 16px', fontSize: 13,
            },
          }),
          h(Btn, { onClick: function () { doSearch(q) }, primary: true, disabled: loading }, loading ? '…' : '搜索'),
          h(Btn, {
            onClick: function () {
              var sd = String(Date.now() % 1000000)
              setSeed(sd); loadHome(sd)
            },
          }, '换一批'),
          h(Btn, { onClick: function () { loadHome(seed) } }, '首页'),
          login && login.logged ? null : h(Btn, { onClick: tryLogin }, '读取登录态')),
        recent.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
          h('span', { style: { color: C.sub, fontSize: 12 } }, '最近：'),
          recent.slice(0, 8).map(function (it, i) {
            return h('span', {
              key: i,
              onClick: function () {
                openVideo({ id: it.video, title: '最近看过 · ' + it.video })
              },
              style: {
                background: C.chip, border: '1px solid ' + C.line, borderRadius: 999,
                padding: '3px 10px', fontSize: 12, color: C.text, cursor: 'pointer',
              },
            }, it.video.slice(0, 6) + '… · ' + it.count + ' 句')
          })) : null,
        h('div', { style: { color: C.sub, fontSize: 12, marginBottom: 12 } },
          source === 'search'
            ? '搜索「' + q + '」· ' + items.length + ' 条'
            : (login && login.logged
              ? '个性化首页（已登录）· ' + items.length + ' 条'
              : '主题推荐 · 未登录（登录后是个性化首页）· ' + items.length + ' 条')),
        h('div', {
          style: {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14,
          },
        }, items.map(card)),
        cursor ? h('div', { style: { marginTop: 16, textAlign: 'center' } },
          h(Btn, { onClick: more, disabled: loading }, loading ? '加载中…' : '加载更多')) : null,
        (!items.length && !loading)
          ? h(Card, null,
            h('div', { style: { color: C.sub, fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-line' } },
              (diag && diag.innertube === false)
                ? '视频列表是空的：还没配置 YT_INNERTUBE_KEY。\n\n'
                  + '① 浏览器打开 youtube.com，F12 → Network，随便点开一个视频，找 youtubei/v1/… 请求 URL 里的 key= 参数\n'
                  + '② 启动网关前设好环境变量：Windows  set "YT_INNERTUBE_KEY=你的key" ／ macOS·Linux  export YT_INNERTUBE_KEY=你的key\n'
                  + '③ 重启网关，再刷新本页\n\n'
                  + '不配也能用：查词、生词本、复习、看板全部正常，只是不能在这里浏览视频。'
                : '没有内容：换个关键词搜索，或点「换一批」看别的主题推荐。'),
            (diag && diag.ytdlp === false)
              ? h('div', { style: { color: C.warn, fontSize: 12.5, marginTop: 10, lineHeight: 1.8 } },
                '另外没检测到 yt-dlp：字幕点词不可用（其余功能正常）。安装后用 yt-dlp -U 保持更新，2024 的旧版会报 Precondition check failed。')
              : null)
          : null)
    }

    exports.EnglishStudyLearn = LearnTab

    function Inner() {
      var tb = useState('dashboard'), tab = tb[0], setTab = tb[1]
      var body
      if (tab === 'learn') body = h(LearnTab, null)
      else if (tab === 'words') body = h(WordsTab, null)
      else if (tab === 'review') body = h(ReviewTab, null)
      else if (tab === 'dict') body = h(DictTab, null)
      else if (tab === 'settings') body = h(SettingsTab, null)
      else body = h(DashboardTab, null)
      return h('div', {
        style: {
          padding: '18px 22px 40px', maxWidth: 980, margin: '0 auto',
          color: C.text, font: '13px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
          // 父容器是固定高度且会裁溢出：自己必须成为滚动容器，否则卡片再多也滚不动
          height: '100%', minHeight: 0, minWidth: 0, boxSizing: 'border-box',
          flex: '1 1 auto',
          maxHeight: 'calc(100vh - 96px)',
          overflowY: 'auto', overflowX: 'hidden',
          overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 } },
          h(ZsIcon, { size: 22 }),
          h('div', { style: { fontSize: 19, fontWeight: 700 } }, 'English Study'),
          h('span', { style: { color: C.sub, fontSize: 12 } }, '看视频学英语 · 学习数据面板')),
        h('div', {
          style: {
            display: 'flex', gap: 4, borderBottom: '1px solid ' + C.line, marginBottom: 18,
            position: 'sticky', top: 0, zIndex: 10, background: C.card,
            paddingTop: 4,
          },
        },
          TABS.map(function (t) {
            var on = t.key === tab
            return h('button', {
              key: t.key, onClick: function () { setTab(t.key) },
              style: {
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '8px 14px', fontSize: 13,
                color: on ? C.accent : C.sub,
                borderBottom: on ? '2px solid ' + C.accent : '2px solid transparent',
                fontWeight: on ? 700 : 400,
              },
            }, t.label)
          })),
        body)
    }

    var inject = ['slots']

    function apply(ctx) {
      try {
        var gwUrl = ctx && ctx.config && ctx.config.gateway
        if (gwUrl) GATEWAY = String(gwUrl).replace(/\/+$/, '')
      } catch (e) { /* 没配就用默认 */ }
      // 加载探针：宿主侧会记一条日志，用来确认面板真的挂载（GUI 需鉴权，不能直接看 DOM）
      try { fetch(API + '/api/client-ping').catch(function () {}) } catch (e) {}
      // 注入表由宿主启动时一次性收集：apply 里第一件事就注册
      return ctx.slots.inject('main', function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          var stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
            return h(Boundary, null, h(Inner, null))
          })
          var stopIcon
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 23,
              label: function () { return 'English Study' },
            }, SidebarIcon)
          } catch (e) {
            if (typeof stopMain === 'function') stopMain()
            throw e
          }
          return function () {
            if (typeof stopIcon === 'function') stopIcon()
            if (typeof stopMain === 'function') stopMain()
          }
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-english-study'
    exports.EnglishStudyPage = function () { return h(Boundary, null, h(Inner, null)) }
    exports.EnglishStudyIcon = SidebarIcon
    return module.exports
  },
})
