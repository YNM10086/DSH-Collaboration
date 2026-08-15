// DSH Collab — 多窗口同项目协作（bundle 版 v3.0）
// 宿主组合插件：所有会话自动获得 collab 工具，随宿主启动加载，重启不丢。
// 身份按"调用者 agent"区分（WeakMap），fork 窗口即使共享 sessionId 也互不干扰。
// 设计文档：docs/superpowers/specs/2026-08-15-dsh-collab-plugin-design.md
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'collab'

export const inject = ['tools', 'fs', 'agents', 'sessions', 'sandboxPolicy', 'systemPrompt', 'timer']

export const Config = Schema.object({
  ttlMs: Schema.number().default(15 * 60 * 1000),
  heartbeatMs: Schema.number().default(60 * 1000),
})

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function apply(ctx) {
  const config = ctx.config ?? {}
  const ttlMs = config.ttlMs ?? 15 * 60 * 1000
  const heartbeatMs = config.heartbeatMs ?? 60 * 1000

  const fs = ctx.fs
  const agents = ctx.agents
  const tools = ctx.tools

  // ---- per-agent 窗口状态（宿主级一个实例服务所有窗口） ----
  const windowStates = new WeakMap()
  // WeakMap 不可遍历，另用 allStates 数组登记（心跳/清理遍历用）
  const allStates = []

  function stateFor(agent) {
    let s = windowStates.get(agent)
    if (!s) {
      s = {
        agent: agent,
        token: Math.random().toString(36).slice(2, 8),
        sessionId: undefined,
        letter: undefined,
        workspaceRoot: undefined,
        session: undefined,
        locks: new Map(),
      }
      windowStates.set(agent, s)
      allStates.push(s)
    }
    return s
  }

  const now = () => Date.now()
  const log = (...a) => console.log('[collab]', ...a)

  // ---- 路径工具 ----
  function normalizeCore(p) {
    if (typeof p !== 'string') return ''
    let s = p.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '')
    const parts = []
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return parts.join('/').toLowerCase()
  }
  function normalize(state, p) {
    const plain = normalizeCore(p)
    const wr = state.workspaceRoot ? normalizeCore(state.workspaceRoot) : ''
    if (wr && plain.indexOf(wr + '/') === 0) return plain.slice(wr.length + 1)
    return plain
  }
  function isCollabPath(state, p) {
    return normalize(state, p).indexOf('.dsh/collab') !== -1
  }
  function slugify(p) {
    return normalizeCore(p).replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file'
  }
  function collabPath(state, rel) {
    return state.workspaceRoot + '/.dsh/collab/' + rel
  }
  function lockPathFor(state, file) {
    return collabPath(state, 'locks/' + slugify(file) + '.lock')
  }
  function identityKey(state) {
    return (state.sessionId || 'unknown') + '#' + state.token
  }

  // ---- 工作区/会话解析（惰性 + 缓存） ----
  async function resolveWorkspace(state) {
    if (state.workspaceRoot) return true
    let root
    try {
      if (state.agent && state.agent.session && state.agent.session.header && state.agent.session.header.cwd) {
        root = String(state.agent.session.header.cwd)
        state.session = state.agent.session
      }
    } catch (e) { root = undefined }
    if (!root && ctx.sandboxPolicy && ctx.sandboxPolicy.workspaceRoot) root = String(ctx.sandboxPolicy.workspaceRoot)
    if (!root) return false
    state.workspaceRoot = root
    return true
  }

  // ---- fs 读写（sandboxPolicy + 版本守卫 + 重试） ----
  async function readTextSafe(state, path) {
    try { return await fs.readText(await fs.resolve(path)) } catch (e) { return undefined }
  }
  async function writeTextSafe(state, path, content) {
    let expected
    try {
      const info = await fs.stat(await fs.resolve(path))
      if (info && info.version !== undefined) expected = { version: info.version }
    } catch (e) { expected = undefined }
    let sandboxPolicy
    try {
      sandboxPolicy = state.session ? ctx.sandboxPolicy.resolve({ session: state.session }) : ctx.sandboxPolicy.resolve()
    } catch (e) { sandboxPolicy = undefined }
    try {
      await fs.writeText(await fs.resolve(path), content, expected, undefined, sandboxPolicy)
      return true
    } catch (e) {
      try { await fs.writeText(await fs.resolve(path), content, undefined, undefined, sandboxPolicy); return true }
      catch (e2) { log('写入失败', path, String(e2)); return false }
    }
  }
  async function writeJson(state, path, obj) {
    return writeTextSafe(state, path, JSON.stringify(obj, null, 2))
  }

  // ---- 身份注册（key=sessionId#token；写后验证） ----
  async function ensureIdentity(state) {
    if (state.letter) return
    let sid
    try { sid = state.agent && (state.agent.id || state.agent.sessionId) } catch (e) { sid = undefined }
    state.sessionId = sid ? String(sid) : 'unknown'
    const myKey = identityKey(state)
    const idFile = collabPath(state, 'identity.json')
    for (let attempt = 0; attempt < 3; attempt++) {
      let map = {}
      const raw = await readTextSafe(state, idFile)
      if (raw) { try { map = JSON.parse(raw) } catch (e) { map = {} } }
      for (const k of Object.keys(map)) {
        if (k.indexOf('#') === -1) delete map[k]
      }
      if (map[myKey]) {
        state.letter = map[myKey]
        return
      }
      const used = new Set(Object.keys(map).map(k => map[k]))
      let pick
      for (const L of LETTERS) { if (!used.has(L)) { pick = L; break } }
      if (!pick) pick = 'Z'
      if (state.sessionId === 'unknown') { state.letter = pick; return }
      map[myKey] = pick
      if (await writeJson(state, idFile, map)) {
        const after = await readTextSafe(state, idFile)
        let verify = {}
        if (after) { try { verify = JSON.parse(after) } catch (e) { verify = {} } }
        if (verify[myKey] === pick) { state.letter = pick; return }
      }
    }
    state.letter = 'Z'
  }

  // ---- 审计（共享 activity.log，per-agent 字母前缀；内存队列 + 心跳落盘） ----
  const pendingLog = []
  function audit(state, event, target, detail) {
    try {
      pendingLog.push([new Date().toISOString(), state.letter || '?', event, target || '', detail || ''].join(' '))
    } catch (e) { /* ignore */ }
  }
  async function flushLog() {
    if (!pendingLog.length) return
    const lines = pendingLog.splice(0, pendingLog.length)
    // 落盘需要工作区：取任一已解析工作区的 state
    let target = null
    for (const s of allStates) {
      if (s.workspaceRoot) { target = s; break }
    }
    if (!target) return
    const lp = collabPath(target, 'activity.log')
    let prev = (await readTextSafe(target, lp)) || ''
    if (prev && !prev.endsWith('\n')) prev += '\n'
    await writeTextSafe(target, lp, prev + lines.join('\n') + '\n')
  }

  // ---- 锁内存镜像 ----
  function refreshMemory(state, lock) {
    if (!lock) return
    for (const f of (lock.files || [])) {
      const k = normalize(state, f)
      if (!k) continue
      if (lock.released || !lock.holder) state.locks.delete(k)
      else state.locks.set(k, { holder: lock.holder, task: lock.task || '', heartbeat: lock.heartbeat || now(), queue: lock.queue || [] })
    }
  }
  async function refreshFromDisk(state) {
    if (!state.workspaceRoot) return
    const dir = collabPath(state, 'locks')
    let entries
    try { entries = await fs.listDir(await fs.resolve(dir)) } catch (e) { return }
    for (const e of entries || []) {
      const t = e && e.target
      const name = (e && e.name) || (t ? String(fs.processPath(t)).split(/[\\/]/).pop() : '')
      if (!String(name).endsWith('.lock')) continue
      const raw = await readTextSafe(state, collabPath(state, 'locks/' + name))
      if (!raw) continue
      let lock
      try { lock = JSON.parse(raw) } catch (err) { continue }
      refreshMemory(state, lock)
    }
  }

  // ---- 认领 ----
  async function claimOne(state, task, file, cancelWait) {
    const lp = lockPathFor(state, file)
    const raw = await readTextSafe(state, lp)
    let lock
    if (raw) { try { lock = JSON.parse(raw) } catch (e) { lock = undefined } }
    const expired = lock && (now() - (lock.heartbeat || lock.claimedAt || 0) > ttlMs)
    if (cancelWait) {
      if (lock && (lock.queue || []).indexOf(state.letter) !== -1) {
        lock.queue = lock.queue.filter(q => q !== state.letter)
        await writeJson(state, lp, lock)
        return 'ℹ️ ' + file + ': 已退出等待队列'
      }
      return 'ℹ️ ' + file + ': 你不在等待队列中'
    }
    if (!lock || lock.released || expired) {
      const prevQueue = lock && Array.isArray(lock.queue) ? lock.queue.filter(q => q !== state.letter) : []
      const next = { holder: state.letter, task, files: [file], claimedAt: now(), heartbeat: now(), queue: prevQueue, released: false }
      if (!(await writeJson(state, lp, next))) return '❌ ' + file + ': 锁写入失败'
      const after = await readTextSafe(state, lp)
      let holder
      try { holder = after && JSON.parse(after).holder } catch (e) { holder = undefined }
      if (holder !== state.letter) {
        let real
        try { real = JSON.parse(after) } catch (e) { real = undefined }
        refreshMemory(state, real)
        return '⚠️ ' + file + ': 并发认领竞争，当前持有者 窗口' + holder + '，已为你转入等待'
      }
      refreshMemory(state, next)
      audit(state, 'claim', file, 'held')
      return '🔒 ' + file + ': 已由窗口' + state.letter + '持有'
    }
    if (lock.holder === state.letter) { refreshMemory(state, lock); return '🔒 ' + file + ': 已由你持有' }
    if ((lock.queue || []).indexOf(state.letter) === -1) {
      lock.queue = lock.queue || []
      lock.queue.push(state.letter)
      await writeJson(state, lp, lock)
    }
    refreshMemory(state, lock)
    audit(state, 'queue', file, 'position ' + (lock.queue.indexOf(state.letter) + 1))
    return '⏳ ' + file + ': 已被窗口' + lock.holder + '持有，你已排队第 ' + (lock.queue.indexOf(state.letter) + 1) + ' 位（释放后自动接管）'
  }

  // ---- 完成/释放 ----
  async function doneOne(state, file) {
    const lp = lockPathFor(state, file)
    const raw = await readTextSafe(state, lp)
    if (!raw) return 'ℹ️ ' + file + ': 无锁'
    let lock
    try { lock = JSON.parse(raw) } catch (e) { return '⚠️ ' + file + ': 锁文件损坏' }
    if (lock.holder !== state.letter) {
      if ((lock.queue || []).indexOf(state.letter) !== -1) {
        lock.queue = lock.queue.filter(q => q !== state.letter)
        await writeJson(state, lp, lock)
        return 'ℹ️ ' + file + ': 持有者是窗口' + lock.holder + '，你已退出等待队列'
      }
      return 'ℹ️ ' + file + ': 持有者是窗口' + lock.holder + '，无需释放'
    }
    const q = (lock.queue || []).filter(x => x !== state.letter)
    if (q.length) {
      lock.holder = q[0]
      lock.queue = q.slice(1)
      lock.claimedAt = now()
      lock.heartbeat = now()
      lock.released = false
      lock.task = lock.task || ''
    } else {
      lock.holder = null
      lock.released = true
    }
    await writeJson(state, lp, lock)
    refreshMemory(state, lock)
    audit(state, 'done', file, q.length ? ('handover to ' + q[0]) : 'released')
    return q.length ? '✅ ' + file + ': 已释放并交接给窗口' + q[0] : '✅ ' + file + ': 已释放'
  }

  // ---- 板子渲染 ----
  async function renderBoard(state) {
    await refreshFromDisk(state)
    const rows = []
    const ownerOf = new Map()
    const conflicts = []
    for (const [k, lock] of state.locks) {
      if (ownerOf.has(k) && ownerOf.get(k) !== lock.holder) conflicts.push(k)
      ownerOf.set(k, lock.holder)
      const q = (lock.queue || []).length ? '窗口' + lock.queue.join('、窗口') + '(等待)' : '—'
      rows.push('| ' + k + ' | 窗口' + lock.holder + ' | 进行中 | ' + (lock.task || '—') + ' | ' + q + ' |')
    }
    rows.sort()
    let md = '# 协作任务板\n\n'
    md += '> ⚠️ 本板子由插件自动生成；你的窗口身份请用 collab_status 查询，不要从本文件推断\n\n'
    md += '> 最后更新：' + new Date().toISOString() + '（窗口' + (state.letter || '?') + '）\n\n'
    if (conflicts.length) {
      md += '> ⚠️ 冲突：' + conflicts.map(c => '`' + c + '`').join('、') + ' 被多个窗口改动，建议 git diff 人工裁决\n\n'
    }
    md += '| 文件 | 认领人 | 状态 | 任务 | 等待队列 |\n|------|--------|------|------|----------|\n'
    md += rows.length ? rows.join('\n') + '\n' : '（当前无认领）\n'
    await writeTextSafe(state, collabPath(state, 'board.md'), md)
    return md
  }

  // ---- 拦截逻辑 ----
  const WRITE_TOOLS = { write: true, edit: true }
  function checkWrite(execution) {
    const name = typeof execution === 'string' ? execution : (execution && (execution.name || (execution.tool && execution.tool.name)))
    if (!name || !WRITE_TOOLS[name]) return undefined
    const args = execution && execution.arguments
    const p = args && (args.file_path || args.path)
    const agent = execution && execution.agent
    if (!agent || !p) return undefined
    const state = stateFor(agent)
    if (!state.workspaceRoot || isCollabPath(state, p)) return undefined
    const k = normalize(state, p)
    const lock = state.locks.get(k)
    audit(state, 'guard-check', p, 'key=' + k + ' locked=' + (lock ? lock.holder : 'none'))
    if (!lock || !lock.holder || lock.holder === state.letter) return undefined
    if (now() - (lock.heartbeat || 0) > ttlMs) { state.locks.delete(k); return undefined }
    const pos = (lock.queue || []).indexOf(state.letter) + 1
    const queued = pos > 0 ? '，你已排队第 ' + pos + ' 位（释放后自动接管）' : ''
    audit(state, 'denied', p, 'locked by ' + lock.holder)
    return '⛔ ' + p + ' 已被窗口' + lock.holder + '认领（' + (lock.task || '任务') + '）' + queued + '。用 collab_board --refresh 查看板子，或用 collab_claim 传入 cancel_wait=true 退队。'
  }

  // ---- 拦截注册 ----
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const denied = checkWrite(exec)
      if (denied) return { kind: 'deny', reason: denied }
    } catch (e) { /* 放行 */ }
    return next()
  })

  // ---- 纪律注入（全局 section，所有会话可见） ----
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    try {
      ctx.systemPrompt.section({
        name: 'collab-discipline',
        order: 150,
        text: [
          '本窗口运行了 Collab 协作插件（任务板 `.dsh/collab/board.md`，锁目录 `.dsh/collab/locks/`）。',
          '1. 收到派活先调 collab_board 查板（有无冲突、他人认领）。',
          '2. 开工前用 collab_claim <任务> <文件列表> 认领文件；被其他窗口持有则排队等待（任务不取消，先做未锁部分）。',
          '3. 只写自己认领或未认领的文件；写被锁文件会被拦截，拦截时按提示排队或绕开。',
          '4. 完成时用 collab_done 释放锁并登记改动文件。',
          '5. 每回合开始、每次写文件前，先 collab_board --refresh 刷新板子。',
          '6. 你的窗口身份（字母）以用户指定为准：用户说"你是X"就用 collab_identity letter=X 确认；没指定时用 collab_status 查询，不要从 board.md 等文件内容推断。',
        ].join('\n'),
      })
    } catch (e) { log('systemPrompt.section 注入失败', String(e)) }
  }

  // ---- 工具注册 ----
  function textOutput() {
    return {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    }
  }
  async function ready(state) {
    if (!(await resolveWorkspace(state))) return false
    await ensureIdentity(state)
    return true
  }

  const defs = [
    {
      name: 'collab_board',
      description: '读取协作任务板：解析锁目录与审计日志，返回任务/持锁/等待队列/冲突警告的结构化状态，并刷新板子文件。',
      parameters: {
        refresh: { type: 'boolean', description: 'true 时强制从磁盘刷新锁状态' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const state = stateFor(exec.agent)
        if (!(await ready(state))) return { result: '⚠️ 协作工作区未解析，插件未激活' }
        if (args && args.refresh) await refreshFromDisk(state)
        const md = await renderBoard(state)
        return { result: '📋 任务板（本窗口：' + state.letter + '）\n\n' + md }
      },
    },
    {
      name: 'collab_claim',
      description: '认领任务文件：未被持有则立即锁定；被其他窗口持有则进入等待队列（第 N 位，释放后自动接管），不取消任务。cancel_wait=true 退出等待。',
      parameters: {
        task: { type: 'string', required: true, description: '任务描述' },
        files: { type: 'array', items: { type: 'string' }, required: true, description: '要认领的文件路径列表' },
        cancel_wait: { type: 'boolean', description: 'true = 从等待队列退出' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const state = stateFor(exec.agent)
        if (!(await ready(state))) return { result: '⚠️ 协作工作区未解析，插件未激活' }
        const files = Array.isArray(args.files) ? args.files : (args.files ? [args.files] : [])
        if (!files.length) return { result: '⚠️ 请提供 files' }
        const out = []
        for (const f of files) out.push(await claimOne(state, args.task || '未命名任务', f, !!args.cancel_wait))
        await renderBoard(state)
        return { result: out.join('\n') }
      },
    },
    {
      name: 'collab_done',
      description: '完成任务并释放锁：锁交接给等待队列队首（自动接管）。不传 files 则释放本窗口全部锁。',
      parameters: {
        files: { type: 'array', items: { type: 'string' }, description: '要释放的文件路径列表（缺省=全部）' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const state = stateFor(exec.agent)
        if (!(await ready(state))) return { result: '⚠️ 协作工作区未解析，插件未激活' }
        let targets
        if (args && Array.isArray(args.files) && args.files.length) {
          targets = args.files
        } else {
          targets = []
          for (const [k, lock] of state.locks) if (lock.holder === state.letter) targets.push(k)
        }
        const out = []
        for (const f of targets) out.push(await doneOne(state, f))
        await renderBoard(state)
        await flushLog()
        return { result: out.join('\n') }
      },
    },
    {
      name: 'collab_status',
      description: '查看本窗口协作状态：身份字母、持锁列表、排队位次。',
      parameters: {},
      output: textOutput(),
      async execute(args, exec) {
        const state = stateFor(exec.agent)
        if (!(await ready(state))) return { result: '⚠️ 协作工作区未解析，插件未激活' }
        const held = []
        const queued = []
        await refreshFromDisk(state)
        for (const [k, lock] of state.locks) {
          if (lock.holder === state.letter) held.push(k)
          else if ((lock.queue || []).indexOf(state.letter) !== -1) queued.push(k + '(第' + (lock.queue.indexOf(state.letter) + 1) + '位)')
        }
        return { result: '窗口' + state.letter + '（key ' + identityKey(state) + '）\n持锁: ' + (held.length ? held.join(', ') : '无') + '\n排队: ' + (queued.length ? queued.join(', ') : '无') }
      },
    },
    {
      name: 'collab_identity',
      description: '查询或指定本窗口身份字母：无参数=查看当前身份与注册表全貌；带 letter=把本窗口绑定到指定字母（该字母被其他窗口占用时需 force=true 接管）。',
      parameters: {
        letter: { type: 'string', description: '要绑定的身份字母（A-Z，大写）' },
        force: { type: 'boolean', description: 'true = 即使该字母被其他窗口占用也接管（谨慎）' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const state = stateFor(exec.agent)
        if (!(await resolveWorkspace(state))) return { result: '⚠️ 协作工作区未解析，插件未激活' }
        let sid
        try { sid = state.agent && (state.agent.id || state.agent.sessionId) } catch (e) { sid = undefined }
        state.sessionId = sid ? String(sid) : 'unknown'
        const idFile = collabPath(state, 'identity.json')
        let map = {}
        const raw = await readTextSafe(state, idFile)
        if (raw) { try { map = JSON.parse(raw) } catch (e) { map = {} } }
        for (const k of Object.keys(map)) {
          if (k.indexOf('#') === -1) delete map[k]
        }
        const myKey = identityKey(state)
        const want = args && args.letter ? String(args.letter).toUpperCase() : undefined
        if (!want) {
          await ensureIdentity(state)
          const lines = []
          lines.push('本窗口身份：' + (state.letter || '未注册') + '（key ' + myKey + '）')
          lines.push('注册表：')
          const keys = Object.keys(map).sort()
          if (!keys.length) lines.push('  （空）')
          for (const k of keys) lines.push('  窗口' + map[k] + ' ← ' + k)
          return { result: lines.join('\n') }
        }
        if (!/^[A-Z]$/.test(want)) return { result: '⚠️ 身份字母必须是单个大写字母 A-Z' }
        if (want === state.letter) return { result: '✅ 本窗口身份确认：窗口' + want + '（无变更）' }
        let occupiedBy = null
        for (const k of Object.keys(map)) {
          if (map[k] === want && k !== myKey) { occupiedBy = k; break }
        }
        if (occupiedBy && !(args && args.force)) {
          return { result: '⛔ 窗口' + want + ' 已被其他窗口占用（key ' + occupiedBy + '）。确认由本窗口接管请传 force=true，或另选字母。' }
        }
        if (state.sessionId !== 'unknown') {
          if (occupiedBy && args && args.force) delete map[occupiedBy]
          map[myKey] = want
        }
        if (!(await writeJson(state, idFile, map))) return { result: '❌ 身份写入失败' }
        const after = await readTextSafe(state, idFile)
        let verify = {}
        if (after) { try { verify = JSON.parse(after) } catch (e) { verify = {} } }
        if (verify[myKey] !== want) return { result: '⚠️ 身份写入验证失败（并发冲突），请重试' }
        state.letter = want
        audit(state, 'identity', 'assigned', 'window ' + want + (occupiedBy ? ' (force, released ' + occupiedBy + ')' : ''))
        await renderBoard(state)
        await flushLog()
        return { result: '✅ 本窗口身份已指定：窗口' + want + '（key ' + myKey + '）' }
      },
    },
  ]

  for (const d of defs) {
    try {
      tools.register(defineTool(d))
    } catch (e) { log('工具注册失败', d.name, String(e)) }
  }

  // ---- 心跳：刷新持锁心跳 + 刷内存镜像 + 审计落盘 ----
  ctx.setInterval(async () => {
    try {
      for (const state of allStates) {
        if (!state.workspaceRoot) continue
        try { await refreshFromDisk(state) } catch (e) { /* ignore */ }
        try {
          for (const [k, lock] of state.locks) {
            if (!lock.holder || lock.holder !== state.letter) continue
            const lp = lockPathFor(state, k)
            const raw = await readTextSafe(state, lp)
            if (!raw) continue
            let l
            try { l = JSON.parse(raw) } catch (e) { continue }
            if (l.holder !== state.letter) continue
            l.heartbeat = now()
            await writeJson(state, lp, l)
          }
        } catch (e) { /* ignore */ }
      }
      await flushLog()
    } catch (e) { /* ignore */ }
  }, heartbeatMs)

  // ---- 清理：停止时释放全部窗口的锁 ----
  ctx.effect(() => {
    return () => {
      for (const state of allStates) {
        if (!state.workspaceRoot) continue
        for (const [k, lock] of state.locks) {
          if (!lock.holder || lock.holder !== state.letter) continue
          const lp = lockPathFor(state, k)
          readTextSafe(state, lp).then((r) => {
            if (!r) return
            let l
            try { l = JSON.parse(r) } catch (e) { return }
            if (l.holder !== state.letter) return
            const q = (l.queue || []).filter(x => x !== state.letter)
            if (q.length) { l.holder = q[0]; l.queue = q.slice(1); l.heartbeat = now() }
            else { l.holder = null; l.released = true }
            writeJson(state, lp, l)
          }).catch(() => {})
        }
      }
      flushLog()
    }
  })

  log('Collab bundle 已挂载（v3.0，宿主级）')
}
