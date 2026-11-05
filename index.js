// dsh-english-study · 宿主侧（Node）
// 1) 把 127.0.0.1:8788 网关的 API 代理成同域路由 /dsh-english-study/api/*
//    （面板与宿主同源，避开 CORS / 混合内容；网关换端口只改配置）
// 2) 网关停机时自愈拉起（复用现成启动脚本，插件源码不保存密钥）
// 3) 注册只读的 english-study 工具 + 客户端加载探针
// 契约照抄 dsh-music：root.inject(['webServer']) 里 webServer.register({kind:'exact',...})
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-english-study'
export const inject = ['tools']

const DEFAULT_BASE = '/dsh-english-study'
// 网关地址：换端口用 ES_GATEWAY 覆盖，插件源码不用改
const DEFAULT_GATEWAY = process.env.ES_GATEWAY || 'http://127.0.0.1:8788'
// 仓库布局就是「插件在根、网关在 gateway/、扩展在 ext/」，
// 所以默认按插件自身目录推算，不写死任何绝对路径。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const GATEWAY_DIR = process.env.ES_GATEWAY_DIR || PLUGIN_DIR

// 需要透传的网关接口（面板目前用到 health/stats/words/review/due/review/grade/dict，
// 其余一并代理，便于以后加 tab 不用再改宿主）
const API_PATHS = [
  '/api/health', '/api/stats',
  '/api/yt/cues', '/api/yt/recent', '/api/yt/home', '/api/yt/search',
  '/api/yt/login', '/api/yt/thumb',
  '/api/words', '/api/words/lemmas', '/api/words/add', '/api/words/remove',
  '/api/review/due', '/api/review/grade',
  '/api/lookups', '/api/dict', '/api/sentences',
  '/api/dictation/next', '/api/dictation/stats',
  '/api/report', '/api/report/md', '/api/export.csv',
  '/api/explain', '/api/subtitle_zh', '/api/translate',
  '/api/tick', '/api/lookup-log',
  '/api/sentences/add', '/api/sentences/remove',
  '/api/dictation/check', '/api/report/save',
]

function msgOf(e) {
  return (e && (e.message || String(e))) || String(e)
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (e) { /* 连接已断 */ }
}

function logLoad(obj) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-english-study-load-logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'plugin-loaded.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...obj }) + '\n')
  } catch (e) { /* 日志失败不影响插件 */ }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

// ── 网关自愈 ────────────────────────────────────────────────────────────
// 宿主重启不会重跑「启动夹」的登录自启，8788 经常随之停机；
// 面板第一次请求失败时把网关拉起来，再重试一次，避免整块面板 502。
let lastSpawnAt = 0
let spawning = false

function probe(upstream) {
  return fetch(upstream + '/api/health', { signal: AbortSignal.timeout(1800) })
    .then((r) => r.ok)
    .catch(() => false)
}

async function waitReady(upstream, ms) {
  // python 启动 + SQLite/AI 初始化可能要 5~10 秒，固定 sleep 会误判
  const end = Date.now() + ms
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 700))
    if (await probe(upstream)) return true
  }
  return false
}

async function ensureGateway(upstream) {
  if (await probe(upstream)) return true
  const now = Date.now()
  if (spawning || now - lastSpawnAt < 20000) {
    // 已有拉起动作在进行：只等就绪，绝不重复 spawn（重复会端口冲突）
    return waitReady(upstream, 12000)
  }
  lastSpawnAt = now
  spawning = true
  try {
    // 目录不存在时直接放弃：cwd 不合法会让 spawn 抛错，而 detached 子进程的 error
    // 事件没人监听就会把宿主进程一起带走（2026-11-05 连崩三次的根因）。
    if (!existsSync(GATEWAY_DIR)) {
      logLoad({ event: 'gateway-spawn-skip', reason: 'gateway-dir-missing', dir: GATEWAY_DIR })
      return false
    }
    // 按平台选择拉起方式：Windows 走现成 .cmd（它自己设 ES_API / ES_MODEL，插件不碰密钥）；
    // macOS / Linux 直接 spawn Python 跑同一份 server.py。早期版本写死 cmd.exe，
    // 结果在非 Windows 上必然 ENOENT —— 「自动拉起网关」只在 Windows 成立。
    const onWin = process.platform === 'win32'
    const py = process.env.ES_PYTHON || 'python3'
    const child = onWin
      ? spawn('cmd.exe', ['/d', '/c', 'start-gateway-hidden.cmd'], {
          cwd: GATEWAY_DIR,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
      : spawn(py, [join(GATEWAY_DIR, 'gateway', 'server.py')], {
          cwd: GATEWAY_DIR,
          detached: true,
          stdio: 'ignore',
        })
    child.on('error', (e) => logLoad({ event: 'gateway-spawn-error', error: msgOf(e) }))
    child.unref()
    logLoad({ event: 'gateway-spawn', dir: GATEWAY_DIR, childPid: child.pid })
    return await waitReady(upstream, 15000)
  } catch (e) {
    logLoad({ event: 'gateway-spawn-failed', error: msgOf(e) })
    return false
  } finally {
    spawning = false
  }
}

async function proxy(req, res, subPath, upstream) {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  const init = { method: req.method || 'GET', signal: AbortSignal.timeout(25000) }
  try {
    if (req.method === 'POST' || req.method === 'PUT') {
      init.body = await readBody(req)
      init.headers = { 'Content-Type': 'application/json' }
    }
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '读取请求体失败：' + msgOf(e) })
  }

  async function forward() {
    const r = await fetch(upstream + subPath + (u.search || ''), init)
    const text = await r.text()
    try {
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(text)
    } catch (e) { /* 连接已断 */ }
  }

  try {
    await forward()
  } catch (e) {
    let retried = false
    try {
      if (await ensureGateway(upstream)) {
        await forward()
        retried = true
      }
    } catch (e2) { /* 重试也失败 */ }
    if (retried) return
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: '网关不可达：' + msgOf(e) })
    else { try { res.end() } catch (_) {} }
  }
}

// ── 学习浏览器（YouTube 点词学习）──────────────────────────────────────
// 实测 YouTube 返回 X-Frame-Options: SAMEORIGIN，宿主主窗口 webviewTag:false，
// 所以不能把 youtube.com 塞进插件面板；改为由 Harness 一键拉起受控 Edge 窗口。
// 视频里点词 → 扩展 → 8788 网关 → 插件看板，数据仍回流 Harness。
const EDGE = process.env.ES_EDGE ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const LEARN_PROFILE = process.env.ES_LEARN_PROFILE ||
  join(homedir(), '.dsh', 'english-study-edge-profile')
const LEARN_EXT = process.env.ES_LEARN_EXT || join(PLUGIN_DIR, 'ext')
let lastLearnOpenAt = 0

function safeYoutubeUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'https:') return null
    const h = u.hostname.toLowerCase()
    const allowed = h === 'youtube.com' || h.endsWith('.youtube.com') ||
      h === 'youtu.be' || h.endsWith('.youtu.be') ||
      h === 'youtube-nocookie.com'
    return allowed ? u.toString() : null
  } catch (e) { return null }
}

function learnStatus() {
  return {
    ok: true,
    edge: existsSync(EDGE),
    profile: existsSync(LEARN_PROFILE),
    extension: existsSync(join(LEARN_EXT, 'manifest.json')),
    gateway: existsSync(join(GATEWAY_DIR, 'gateway', 'server.py')),
    lastOpenAt: lastLearnOpenAt || null,
  }
}

function openLearnBrowser(rawUrl) {
  const url = safeYoutubeUrl(rawUrl) || 'https://www.youtube.com'
  if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE)
  if (!existsSync(join(LEARN_EXT, 'manifest.json'))) throw new Error('学习扩展缺失：' + LEARN_EXT)
  // spawn 用数组参数，不拼 shell；url 已做域名白名单，避免命令注入
  const args = [
    '--user-data-dir=' + LEARN_PROFILE,
    '--load-extension=' + LEARN_EXT,
    '--disable-extensions-except=' + LEARN_EXT,
    '--no-first-run', '--no-default-browser-check',
    '--new-window', url,
  ]
  const child = spawn(EDGE, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  lastLearnOpenAt = Date.now()
  logLoad({ event: 'learn-open', url, childPid: child.pid })
  return { ok: true, url, pid: child.pid }
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export function apply(ctx, config) {
  const cfg = config || {}
  const base = cfg.basePath || DEFAULT_BASE
  const upstream = cfg.gateway || DEFAULT_GATEWAY
  const state = { routes: 0, tools: 0, failed: [], upstream, base }
  const root = ctx.root ?? ctx

  function registerRoutes(c) {
    const ws = c.webServer ?? c.get?.('webServer')
    if (!ws || typeof ws.register !== 'function') {
      state.failed.push('no-webServer')
      logLoad(state)
      return
    }
    for (const p of API_PATHS) {
      try {
        ws.register({
          kind: 'exact',
          path: base + p,
          handler: (req, res) => proxy(req, res, p, upstream),
        })
        state.routes++
      } catch (e) {
        state.failed.push('route ' + p + ': ' + msgOf(e))
      }
    }
    // 客户端加载探针：GUI 刷新后 client.js 会 ping 一下，用来确认面板真的挂载了
    try {
      ws.register({
        kind: 'exact',
        path: base + '/api/client-ping',
        handler: (_req, res) => {
          logLoad({ event: 'client-ping' })
          sendJson(res, 200, { ok: true, plugin: name })
        },
      })
      state.routes++
    } catch (e) {
      state.failed.push('client-ping: ' + msgOf(e))
    }
    // 学习浏览器：组件自检 + 一键打开（带副作用，只由面板按钮触发，不暴露给模型工具）
    const learnRoutes = [
      {
        path: base + '/api/learn/status',
        handler: (_req, res) => sendJson(res, 200, learnStatus()),
      },
      {
        path: base + '/api/learn/open',
        handler: async (req, res) => {
          try {
            const raw = (await readBody(req)).toString('utf8')
            const body = raw ? JSON.parse(raw) : {}
            sendJson(res, 200, openLearnBrowser(body && body.url))
          } catch (e) {
            sendJson(res, 400, { ok: false, error: msgOf(e) })
          }
        },
      },
    ]
    for (const r of learnRoutes) {
      try {
        ws.register({ kind: 'exact', path: r.path, handler: r.handler })
        state.routes++
      } catch (e) {
        state.failed.push('learn: ' + msgOf(e))
      }
    }
    logLoad(state)
  }

  // webServer 可能晚于 apply 就绪，用 inject 等它（与 dsh-music 一致）
  try {
    if (root && typeof root.inject === 'function') root.inject(['webServer'], registerRoutes)
    else registerRoutes(ctx)
  } catch (e) {
    state.failed.push('inject webServer: ' + msgOf(e))
  }

  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register({
        name: 'english_study',
        description: 'English Study 学习数据（只读）：统计总览、查词、待复习词。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['stats', 'dict', 'due'],
              description: 'stats=统计总览；dict=查词；due=待复习词',
            },
            word: { type: 'string', description: 'dict 用的英文单词' },
          },
          required: ['action'],
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
          const action = String((args && args.action) || 'stats')
          let path = '/api/stats'
          if (action === 'due') path = '/api/review/due'
          if (action === 'dict') {
            const w = encodeURIComponent(String((args && args.word) || '').trim())
            if (!w) return '请提供 word'
            path = '/api/dict?word=' + w
          }
          try {
            await ensureGateway(upstream)
            const r = await fetch(upstream + path, { signal: AbortSignal.timeout(15000) })
            return JSON.stringify(await r.json(), null, 2).slice(0, 4000)
          } catch (e) {
            return '网关不可达：' + msgOf(e)
          }
        },
      })
      state.tools++
    } else {
      state.failed.push('no-tools')
    }
  } catch (e) {
    state.failed.push('tool: ' + msgOf(e))
  }

  logLoad(state)
  console.log(`[dsh-english-study] apply done: routes(pending)=${API_PATHS.length + 3} tools=${state.tools} upstream=${upstream}${state.failed.length ? ' failed=' + JSON.stringify(state.failed) : ''}`)

  // 后台探活：网关停机时主动拉起，不等面板第一次请求
  setTimeout(() => { ensureGateway(upstream).catch(() => {}) }, 2500)
}
