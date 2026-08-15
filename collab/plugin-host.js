// DSH Collab 插件 — 多窗口同项目协作（v1.2，文件协议版）
// 用法：本文件内容就是 cordis_define 的 code.host 函数体。
// 每个窗口各跑一份：cordis_define(kind=new, idPrefix=collab, code.host=本文件内容) → cordis_run。
// 设计文档：docs/superpowers/specs/2026-08-15-dsh-collab-plugin-design.md
// v1.1 修复：PromptSection 用 {name,order,text}；工具定义补 parameters/output/render；守卫读 execution.arguments。
// v1.2 修复：工作区根改为惰性解析（工具执行时 initiator 可用）。
// v1.3 修复：正确的字段路径是 agent.session.header.cwd（对照 dsh-tool-fs 的 sessionResolveOptions）。
// v1.4 修复：registerTool 只接受 harness.defineTool 标记过的定义，先 defineTool 再 registerTool。
// v1.5 修复：工具名必须匹配 ^[a-zA-Z0-9_-]+$（模型 API 限制），collab.board → collab_board 等，禁止点号。
// v1.6 修复：fs.writeText 必须传 sandboxPolicy（ctx.sandboxPolicy.resolve({session})），否则沙箱后端拒绝写入。
// v1.7 修复：normalize 剥离工作区前缀——write 工具传绝对路径，锁 key 是相对路径，此前不匹配导致守卫漏拦。
// v1.8 修复：tools.guard 在动态插件上下文未生效（零调用），改走 tools/pre-execute waterfall（deny 决策）+ 保留 guard 双通道。
// v1.9 修复：身份注册写后验证 + 冲突重选（并发首启竞态）；板子顶部加"身份以 collab_status 为准"防新窗口误读。
// v2.0 特性：collab_identity 工具——用户直接指定窗口身份（letter 参数），被占用可 force 接管；纪律改为"身份以用户指定为准"。
// v2.1 修复：身份注册表 key 改为 sessionId#窗口实例token——fork 出的窗口共用 sessionId，旧 key 导致 A/B 互相覆盖。
return {
  inject: ['timer'],
  apply(ctx) {
    try {
      const TTL_MS = 15 * 60 * 1000          // 锁过期时间（心跳超时）
      const HEARTBEAT_MS = 60 * 1000         // 心跳/刷新周期
      const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

      // ---- 可选服务 ----
      const fs = ctx.get('fs')
      const agents = ctx.get('agents')
      const tools = ctx.get('tools')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const systemPrompt = ctx.get('systemPrompt')
      if (!fs || !agents) {
        console.log('[collab] fs/agents 服务不可用，插件未激活')
        return
      }

      // ---- 内存状态 ----
      // 窗口实例 token：fork 出的窗口可能共用 sessionId，必须用实例级 key 区分
      const windowToken = Math.random().toString(36).slice(2, 8)
      const state = {
        workspaceRoot: undefined,  // 惰性解析，缓存
        session: undefined,        // 会话对象（写文件时用于解析 sandboxPolicy）
        sessionId: undefined,      // 本窗口会话 id（fork 窗口可能共用）
        windowToken: windowToken,  // 本窗口实例唯一 token
        letter: undefined,         // A / B / C ...
        locks: new Map(),          // 规范化文件路径 -> { holder, task, files, claimedAt, heartbeat, queue }
      }
      // 注册表 key：sessionId#token（实例唯一）
      function identityKey() {
        return (state.sessionId || 'unknown') + '#' + state.windowToken
      }

      const now = () => Date.now()
      const log = (...a) => console.log('[collab]', ...a)

      // ---- 工作区根：惰性解析 + 缓存 ----
      async function resolveWorkspace() {
        if (state.workspaceRoot) return true
        let root
        try {
          const agent = agents.currentInitiator()
          if (agent && agent.session && agent.session.header && agent.session.header.cwd) {
            root = String(agent.session.header.cwd)
            state.session = agent.session
          }
        } catch (e) { root = undefined }
        if (!root) {
          try {
            const sq = ctx.get('sessionQuery')
            if (sq && typeof sq.listSessions === 'function') {
              const agent2 = agents.currentInitiator()
              const sid = agent2 && (agent2.id || agent2.sessionId)
              if (sid) {
                const recs = await sq.listSessions()
                for (const r of recs || []) {
                  if (r && r.meta && r.meta.id === sid && r.meta.cwd) { root = String(r.meta.cwd); break }
                }
              }
            }
          } catch (e) { /* ignore */ }
        }
        if (!root && sandboxPolicy && sandboxPolicy.workspaceRoot) root = String(sandboxPolicy.workspaceRoot)
        if (!root) return false
        state.workspaceRoot = root
        log('工作区根:', root)
        return true
      }

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
      function normalize(p) {
        const plain = normalizeCore(p)
        const wr = state.workspaceRoot ? normalizeCore(state.workspaceRoot) : ''
        if (wr && plain.indexOf(wr + '/') === 0) return plain.slice(wr.length + 1)
        return plain
      }
      function isCollabPath(p) {
        return normalize(p).indexOf('.dsh/collab') !== -1
      }
      function slugify(p) {
        return normalize(p).replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file'
      }
      function collabPath(rel) {
        return state.workspaceRoot + '/.dsh/collab/' + rel
      }
      function lockPathFor(file) {
        return collabPath('locks/' + slugify(file) + '.lock')
      }

      // ---- fs 读写（带版本守卫 + 重试） ----
      async function readTextSafe(path) {
        try { return await fs.readText(await fs.resolve(path)) } catch (e) { return undefined }
      }
      async function writeTextSafe(path, content) {
        let expected
        try {
          const info = await fs.stat(await fs.resolve(path))
          if (info && info.version !== undefined) expected = { version: info.version }
        } catch (e) { expected = undefined }
        let sandboxPolicy
        try {
          const sp = ctx.get('sandboxPolicy')
          if (sp && typeof sp.resolve === 'function') {
            sandboxPolicy = state.session ? sp.resolve({ session: state.session }) : sp.resolve()
          }
        } catch (e) { sandboxPolicy = undefined }
        try {
          await fs.writeText(await fs.resolve(path), content, expected, undefined, sandboxPolicy)
          return true
        } catch (e) {
          try { await fs.writeText(await fs.resolve(path), content, undefined, undefined, sandboxPolicy); return true }
          catch (e2) { log('写入失败', path, String(e2)); return false }
        }
      }
      async function writeJson(path, obj) {
        return writeTextSafe(path, JSON.stringify(obj, null, 2))
      }

      // ---- 身份注册（key=sessionId#token；写后验证防并发竞态） ----
      async function ensureIdentity() {
        if (state.letter) return
        let sid
        const agent = agents.currentInitiator()
        try { sid = agent && (agent.id || agent.sessionId) } catch (e) { sid = undefined }
        state.sessionId = sid ? String(sid) : 'unknown'
        const myKey = identityKey()
        const idFile = collabPath('identity.json')
        for (let attempt = 0; attempt < 3; attempt++) {
          let map = {}
          const raw = await readTextSafe(idFile)
          if (raw) { try { map = JSON.parse(raw) } catch (e) { map = {} } }
          // 迁移：清理旧格式（无 # 的 sessionId 直接作 key）条目
          for (const k of Object.keys(map)) {
            if (k.indexOf('#') === -1) delete map[k]
          }
          if (map[myKey]) {
            state.letter = map[myKey]
            log('身份复用:', state.letter, myKey)
            return
          }
          const used = new Set(Object.keys(map).map(k => map[k]))
          let pick
          for (const L of LETTERS) { if (!used.has(L)) { pick = L; break } }
          if (!pick) pick = 'Z'
          if (state.sessionId === 'unknown') { state.letter = pick; return }
          map[myKey] = pick
          if (await writeJson(idFile, map)) {
            // 写后验证：确认自己的注册没被并发覆盖
            const after = await readTextSafe(idFile)
            let verify = {}
            if (after) { try { verify = JSON.parse(after) } catch (e) { verify = {} } }
            if (verify[myKey] === pick) {
              state.letter = pick
              log('身份注册:', state.letter, myKey)
              return
            }
            log('身份注册竞态，重试', attempt + 1)
          }
        }
        state.letter = 'Z'
        log('身份注册重试耗尽，兜底 Z:', myKey)
      }

      // ---- 审计（内存队列 + 周期落盘） ----
      const pendingLog = []
      function audit(event, target, detail) {
        try {
          pendingLog.push([new Date().toISOString(), state.letter || '?', event, target || '', detail || ''].join(' '))
        } catch (e) { /* ignore */ }
      }
      async function flushLog() {
        if (!pendingLog.length || !state.workspaceRoot) return
        const lines = pendingLog.splice(0, pendingLog.length)
        const lp = collabPath('activity.log')
        let prev = (await readTextSafe(lp)) || ''
        if (prev && !prev.endsWith('\n')) prev += '\n'
        await writeTextSafe(lp, prev + lines.join('\n') + '\n')
      }
      // fs/observed：所有写入（含其他窗口）的观察事件 → 审计（同步记录，不得抛错）
      ctx.on('fs/observed', (target, observation, actor) => {
        try {
          const t = target && target.displayPath
          if (!t || isCollabPath(String(t))) return
          const actorName = actor && actor.name
          const agentId = actor && actor.agent && (actor.agent.id || actor.agent.sessionId)
          const ver = observation && observation.kind === 'present' ? String(observation.version) : 'absent'
          audit('observed', String(t), (actorName || '?') + (agentId ? '/' + String(agentId).slice(0, 8) : '') + ' v' + ver)
        } catch (e) { /* listener 不得抛错 */ }
      })

      // ---- 锁内存镜像 ----
      function refreshMemory(lock) {
        if (!lock) return
        for (const f of (lock.files || [])) {
          const k = normalize(f)
          if (!k) continue
          if (lock.released || !lock.holder) state.locks.delete(k)
          else state.locks.set(k, { holder: lock.holder, task: lock.task || '', heartbeat: lock.heartbeat || now(), queue: lock.queue || [] })
        }
      }
      async function refreshFromDisk() {
        if (!state.workspaceRoot) return
        const dir = collabPath('locks')
        let entries
        try { entries = await fs.listDir(await fs.resolve(dir)) } catch (e) { return }
        for (const e of entries || []) {
          const t = e && e.target
          const name = (e && e.name) || (t ? String(fs.processPath(t)).split(/[\\/]/).pop() : '')
          if (!String(name).endsWith('.lock')) continue
          const raw = await readTextSafe(collabPath('locks/' + name))
          if (!raw) continue
          let lock
          try { lock = JSON.parse(raw) } catch (err) { continue }
          refreshMemory(lock)
        }
      }

      // ---- 认领 ----
      async function claimOne(task, file, cancelWait) {
        const lp = lockPathFor(file)
        const raw = await readTextSafe(lp)
        let lock
        if (raw) { try { lock = JSON.parse(raw) } catch (e) { lock = undefined } }
        const expired = lock && (now() - (lock.heartbeat || lock.claimedAt || 0) > TTL_MS)
        if (cancelWait) {
          if (lock && (lock.queue || []).indexOf(state.letter) !== -1) {
            lock.queue = lock.queue.filter(q => q !== state.letter)
            await writeJson(lp, lock)
            return 'ℹ️ ' + file + ': 已退出等待队列'
          }
          return 'ℹ️ ' + file + ': 你不在等待队列中'
        }
        if (!lock || lock.released || expired) {
          const prevQueue = lock && Array.isArray(lock.queue) ? lock.queue.filter(q => q !== state.letter) : []
          const next = { holder: state.letter, task, files: [file], claimedAt: now(), heartbeat: now(), queue: prevQueue, released: false }
          if (!(await writeJson(lp, next))) return '❌ ' + file + ': 锁写入失败'
          const after = await readTextSafe(lp)
          let holder
          try { holder = after && JSON.parse(after).holder } catch (e) { holder = undefined }
          if (holder !== state.letter) {
            let real
            try { real = JSON.parse(after) } catch (e) { real = undefined }
            refreshMemory(real)
            return '⚠️ ' + file + ': 并发认领竞争，当前持有者 窗口' + holder + '，已为你转入等待'
          }
          refreshMemory(next)
          audit('claim', file, 'held')
          return '🔒 ' + file + ': 已由窗口' + state.letter + '持有'
        }
        if (lock.holder === state.letter) { refreshMemory(lock); return '🔒 ' + file + ': 已由你持有' }
        if ((lock.queue || []).indexOf(state.letter) === -1) {
          lock.queue = lock.queue || []
          lock.queue.push(state.letter)
          await writeJson(lp, lock)
        }
        refreshMemory(lock)
        audit('queue', file, 'position ' + (lock.queue.indexOf(state.letter) + 1))
        return '⏳ ' + file + ': 已被窗口' + lock.holder + '持有，你已排队第 ' + (lock.queue.indexOf(state.letter) + 1) + ' 位（释放后自动接管）'
      }

      // ---- 完成/释放 ----
      async function doneOne(file) {
        const lp = lockPathFor(file)
        const raw = await readTextSafe(lp)
        if (!raw) return 'ℹ️ ' + file + ': 无锁'
        let lock
        try { lock = JSON.parse(raw) } catch (e) { return '⚠️ ' + file + ': 锁文件损坏' }
        if (lock.holder !== state.letter) {
          if ((lock.queue || []).indexOf(state.letter) !== -1) {
            lock.queue = lock.queue.filter(q => q !== state.letter)
            await writeJson(lp, lock)
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
        await writeJson(lp, lock)
        refreshMemory(lock)
        audit('done', file, q.length ? ('handover to ' + q[0]) : 'released')
        return q.length ? '✅ ' + file + ': 已释放并交接给窗口' + q[0] : '✅ ' + file + ': 已释放'
      }

      // ---- 板子渲染（锁目录是唯一事实源，板子是派生视图） ----
      async function renderBoard() {
        await refreshFromDisk()
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
        await writeTextSafe(collabPath('board.md'), md)
        return md
      }

      // ---- 工具守卫：拦截被其他窗口锁定的写入 ----
      const WRITE_TOOLS = { write: true, edit: true }
      // 返回拒绝原因字符串；无拦截返回 undefined
      function checkWrite(execution) {
        const name = typeof execution === 'string' ? execution : (execution && (execution.name || (execution.tool && execution.tool.name)))
        if (!name || !WRITE_TOOLS[name]) return undefined
        const args = execution && execution.arguments
        const p = args && (args.file_path || args.path)
        if (!p || isCollabPath(p)) return undefined
        const k = normalize(p)
        const lock = state.locks.get(k)
        audit('guard-check', p, 'key=' + k + ' locked=' + (lock ? lock.holder : 'none'))
        if (!lock || !lock.holder || lock.holder === state.letter) return undefined
        if (now() - (lock.heartbeat || 0) > TTL_MS) { state.locks.delete(k); return undefined }
        const pos = (lock.queue || []).indexOf(state.letter) + 1
        const queued = pos > 0 ? '，你已排队第 ' + pos + ' 位（释放后自动接管）' : ''
        audit('denied', p, 'locked by ' + lock.holder)
        return '⛔ ' + p + ' 已被窗口' + lock.holder + '认领（' + (lock.task || '任务') + '）' + queued + '。用 collab_board --refresh 查看板子，或用 collab_claim 传入 cancel_wait=true 退队。'
      }
      function guardFn(execution) {
        try { return checkWrite(execution) } catch (e) { return undefined }
      }

      // ---- 心跳：刷新自己锁的心跳 + 刷内存镜像 + 审计落盘 ----
      ctx.interval(async () => {
        if (!state.workspaceRoot) return
        try { await refreshFromDisk() } catch (e) { /* ignore */ }
        try {
          for (const [k, lock] of state.locks) {
            if (!lock.holder || lock.holder !== state.letter) continue
            const lp = lockPathFor(k)
            const raw = await readTextSafe(lp)
            if (!raw) continue
            let l
            try { l = JSON.parse(raw) } catch (e) { continue }
            if (l.holder !== state.letter) continue
            l.heartbeat = now()
            await writeJson(lp, l)
          }
        } catch (e) { /* ignore */ }
        try { await flushLog() } catch (e) { /* ignore */ }
      }, HEARTBEAT_MS)

      // ---- 协作纪律注入（PromptSection: name/order/text） ----
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        try {
          systemPrompt.section({
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
          log('协作纪律已注入 systemPrompt')
        } catch (e) {
          log('systemPrompt.section 注入失败', String(e))
        }
      }

      // ---- 工具注册（parameters + 必填 output + execute 返回规范值） ----
      function textOutput() {
        return {
          schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.result }],
        }
      }
      async function ready() {
        if (!(await resolveWorkspace())) return false
        await ensureIdentity()
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
            if (!(await ready())) return { result: '⚠️ 协作工作区未解析，插件未激活' }
            if (args && args.refresh) await refreshFromDisk()
            const md = await renderBoard()
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
            if (!(await ready())) return { result: '⚠️ 协作工作区未解析，插件未激活' }
            const files = Array.isArray(args.files) ? args.files : (args.files ? [args.files] : [])
            if (!files.length) return { result: '⚠️ 请提供 files' }
            const out = []
            for (const f of files) out.push(await claimOne(args.task || '未命名任务', f, !!args.cancel_wait))
            await renderBoard()
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
            if (!(await ready())) return { result: '⚠️ 协作工作区未解析，插件未激活' }
            let targets
            if (args && Array.isArray(args.files) && args.files.length) {
              targets = args.files
            } else {
              targets = []
              for (const [k, lock] of state.locks) if (lock.holder === state.letter) targets.push(k)
            }
            const out = []
            for (const f of targets) out.push(await doneOne(f))
            await renderBoard()
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
            if (!(await ready())) return { result: '⚠️ 协作工作区未解析，插件未激活' }
            const held = []
            const queued = []
            await refreshFromDisk()
            for (const [k, lock] of state.locks) {
              if (lock.holder === state.letter) held.push(k)
              else if ((lock.queue || []).indexOf(state.letter) !== -1) queued.push(k + '(第' + (lock.queue.indexOf(state.letter) + 1) + '位)')
            }
            return { result: '窗口' + state.letter + '（session ' + state.sessionId + '）\n持锁: ' + (held.length ? held.join(', ') : '无') + '\n排队: ' + (queued.length ? queued.join(', ') : '无') }
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
            if (!(await resolveWorkspace())) return { result: '⚠️ 协作工作区未解析，插件未激活' }
            if (!state.sessionId) {
              const agent = agents.currentInitiator()
              try { state.sessionId = agent && (agent.id || agent.sessionId) ? String(agent.id || agent.sessionId) : 'unknown' } catch (e) { state.sessionId = 'unknown' }
            }
            const idFile = collabPath('identity.json')
            let map = {}
            const raw = await readTextSafe(idFile)
            if (raw) { try { map = JSON.parse(raw) } catch (e) { map = {} } }
            // 迁移：清理旧格式（无 # 的 sessionId 直接作 key）条目
            for (const k of Object.keys(map)) {
              if (k.indexOf('#') === -1) delete map[k]
            }
            const myKey = identityKey()
            const want = args && args.letter ? String(args.letter).toUpperCase() : undefined
            if (!want) {
              await ensureIdentity()
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
            if (!(await writeJson(idFile, map))) return { result: '❌ 身份写入失败' }
            const after = await readTextSafe(idFile)
            let verify = {}
            if (after) { try { verify = JSON.parse(after) } catch (e) { verify = {} } }
            if (verify[myKey] !== want) return { result: '⚠️ 身份写入验证失败（并发冲突），请重试' }
            state.letter = want
            audit('identity', 'assigned', 'window ' + want + (occupiedBy ? ' (force, released ' + occupiedBy + ')' : ''))
            await renderBoard()
            await flushLog()
            return { result: '✅ 本窗口身份已指定：窗口' + want + '（key ' + myKey + '）' }
          },
        },
      ]
      for (const d of defs) {
        try {
          const defined = harness.defineTool(d)
          harness.registerTool(ctx, defined)
        } catch (e) { log('工具注册失败', d.name, String(e)) }
      }

      // ---- 拦截注册：tools.guard + tools/pre-execute 双通道 ----
      let guardStatus = 'not-attempted'
      if (tools && typeof tools.guard === 'function') {
        try { tools.guard(guardFn); guardStatus = 'guard-ok' } catch (e) { guardStatus = 'guard-fail:' + String(e) }
      } else {
        guardStatus = 'no-tools-service'
      }
      let preStatus = 'not-attempted'
      try {
        ctx.on('tools/pre-execute', (exec, next) => {
          try {
            const denied = checkWrite(exec)
            if (denied) return { kind: 'deny', reason: denied }
          } catch (e) { /* 放行 */ }
          return next()
        })
        preStatus = 'pre-execute-ok'
      } catch (e) {
        preStatus = 'pre-execute-fail:' + String(e)
      }
      audit('register', 'status', guardStatus + ' | ' + preStatus)

      // ---- 清理：停止时尽力释放自己的锁 ----
      ctx.effect(() => {
        return () => {
          if (!state.workspaceRoot) return
          for (const [k, lock] of state.locks) {
            if (!lock.holder || lock.holder !== state.letter) continue
            const lp = lockPathFor(k)
            const raw = readTextSafe(lp)
            raw.then((r) => {
              if (!r) return
              let l
              try { l = JSON.parse(r) } catch (e) { return }
              if (l.holder !== state.letter) return
              const q = (l.queue || []).filter(x => x !== state.letter)
              if (q.length) { l.holder = q[0]; l.queue = q.slice(1); l.heartbeat = now() }
              else { l.holder = null; l.released = true }
              writeJson(lp, l)
            }).catch(() => {})
          }
          try { flushLog() } catch (e) { /* ignore */ }
        }
      })

      // ---- 启动初始化（尽力而为，失败等首次工具调用时再解析） ----
      ;(async () => {
        try {
          if (await resolveWorkspace()) {
            await ensureIdentity()
            await refreshFromDisk()
            await renderBoard()
            await flushLog()
            log('初始化完成：窗口' + state.letter + ' @ ' + state.workspaceRoot)
          } else {
            log('工作区未解析，等待首次工具调用时初始化')
          }
        } catch (e) {
          log('初始化异常', String(e))
        }
      })()
    } catch (e) {
      console.log('[collab] apply 异常', String(e))
    }
  },
}
