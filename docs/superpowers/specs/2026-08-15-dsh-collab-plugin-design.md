# DSH Collab 插件设计（多窗口同项目协作 v1）

日期：2026-08-15
状态：已确认（设计讨论通过），未实现

## 1. 背景与目标

对标 Claude Code 桌面端的多窗口并行协作：多个 DSH 窗口（会话）在同一项目里同时编码，互相沟通、避免文件冲突（"不互相肘击"）。

第一阶段目标（MVP，已确认）：

1. **窗口驱动 + 自动登记**：用户在各窗口口头派活；窗口的 agent 开工前自动查板、认领任务、完成时更新状态。
2. **认领 + 审计兜底**：改文件前先认领；被占用时**临时拦截 + 排队接管**（不取消任务）；审计日志记录所有变更，冲突标红提醒。

非目标：GUI 状态面板、窗口间实时消息（二期）。

## 2. 架构决策

**采用方案 A：工作区文件协议 + 每窗口一个动态插件。**

| 决策点 | 结论 |
|---|---|
| 跨窗口共享状态载体 | 项目内文件（`.dsh/collab/`），不用宿主组合服务 |
| 插件形态 | 每个窗口各自 cordis_run 同一份动态插件（动态插件会话私有，每窗口一份实例） |
| 宿主改动 | 零改动（不动 cordis.yml） |
| 防肘击机制 | 认领锁（原子 mkdir）+ 等待队列 + 拦截钩子（`fs/write-intent` 等，见 §7） |
| 审计 | `fs/observed` 事件 + 主动登记，追加写 `activity.log` |

否决的方案：
- 方案 B（宿主组合共享服务）：需部署级变更、重启状态丢失、板子人不可读。留作二期实时层的选项。
- 方案 C（混合）：MVP 过重。

## 3. 目录结构

所有运行时文件统一放在项目根 `.dsh/collab/`：

```
.dsh/
└── collab/
    ├── board.md          # 任务板（人可读，Markdown 表格）
    ├── identity.json     # 身份注册表（sessionId → 窗口字母）
    ├── activity.log      # 审计日志（追加式）
    └── locks/            # 认领锁 + 等待队列（每任务/文件一个 .lock）
```

git 建议：`locks/`、`activity.log`、`identity.json` 加入 `.gitignore`（运行时状态、含机器相关 sessionId）；`board.md` 是否入库由用户决定。

## 4. 身份注册表（窗口命名）

文件：`.dsh/collab/identity.json`，形如：

```json
{ "sess-abc123": "A", "sess-def456": "B" }
```

协议：

- 插件启动时读**一次**：自己的 sessionId 已注册 → 复用原字母；未注册 → 取第一个空闲字母（A、B、C…），原子写入（写临时文件 + rename）。
- 之后字母保存在插件内存中，不再读注册表。
- DSH 会话持久化，窗口重启后 sessionId 不变 → 字母稳定。
- 并发注册竞争：rename 原子性保证最终只有一个写入者生效；发现冲突（自己选的字母已被占用）则重读、重选，最多重试 3 次。
- 窗口在板子上的显示名：`窗口A`、`窗口B`……

身份来源：插件通过 `ctx.agents`（`currentInitiator()`/`get()`）或 `agent/session-start` 事件获取自身 sessionId（实现时验证，见 §14）。

## 5. 任务板格式（board.md）

```markdown
# 协作任务板（最后更新：窗口A 12:03）

| 任务 | 认领人 | 状态 | 改动文件 | 等待队列 |
|------|--------|------|----------|----------|
| 实现登录接口 | 窗口A | 进行中 | src/auth.ts | 窗口B(1) |
| 前端登录页 | 窗口B | 进行中 | src/pages/login.tsx | — |
| 单元测试 | — | 待认领 | — | — |
```

- 状态机：`待认领 → 进行中 → 完成 / 放弃`。
- `等待队列`列：显示排队等锁的窗口及其位次，被拦任务的窗口状态保持"进行中"（任务不取消）。
- **锁目录是唯一事实源，板子是派生视图**：每次工具调用后由插件从锁目录 + 身份表重新合成整份板子。即使两个窗口的插件实例并发重写导致一次覆盖丢失，下一次调用也会从权威锁目录重建，自愈无需合并。板子只有插件写，agent 和用户只读。
- 冲突标记：审计检测到"同文件被多窗口改动"时，板子顶部加 `> ⚠️ 冲突：src/shared.ts 被窗口A、窗口B 同时改动`。

## 6. 锁格式与等待队列

每个任务/文件一个锁文件：`.dsh/collab/locks/<slug>.lock`，JSON：

```json
{
  "holder": "A",
  "task": "实现登录接口",
  "files": ["src/auth.ts"],
  "claimedAt": 1755252000000,
  "heartbeat": 1755252600000,
  "queue": ["B", "C"]
}
```

协议：

- **取锁（claim）**：原子 `mkdir` 锁目录（成功 = 拿到；失败 = 被占）。被占时**不失败**：把自己的窗口字母追加进 `queue` 字段，返回"已排队第 N 位"。
- **释放（done）**：删除锁目录；若 `queue` 非空，队首自动接管（锁目录重建、holder 更新），板子同步更新。
- **过期**：`heartbeat` 超过 TTL（默认 15 分钟）视为死锁 → 队首接管，旧锁内容移入 `activity.log` 留痕。
- **心跳**：插件用 `ctx.timer`（`inject: ['timer']`）周期性刷新自己持锁的心跳；同时监听 `agent/disposed` 事件主动清锁（窗口关闭即释放，不等 TTL）。
- **退队**：`collab_claim` 传 `cancel_wait=true` 把自己从 queue 移除。
- 锁文件写冲突：锁目录用 `mkdir` 原子性（谁 mkdir 成功谁是 holder），锁内 JSON 的 queue 更新用"读-改-原子写"（临时文件+rename），同窗口串行调用无竞争。

## 7. 拦截机制（防肘击核心）

**语义：临时拦截 + 排队接管**。被拦的写入只是"现在不行"，agent 不取消任务，等接管后继续。

拦截点（按优先级，实现时验证作用域，见 §14）：

1. **`fs/write-intent`**（waterfall，`writeText` 前）：检查目标文件是否被其他窗口持锁 → 是则**拒绝本次意图**（返回 undefined/否决），拒绝信息注明"已被窗口X锁定，你已排队第 N 位，释放后自动接管"。
2. **`fs/edit-intent`**（waterfall，`editText` 前）：同上。
3. **备选 `tools.guard`**：若 fs 意图钩子拿不到跨会话作用域，改用工具守卫做同样检查。

配套规则：

- **白名单**：插件自己写 `.dsh/collab/**` 时放行（否则自己锁自己）。
- **接管后放行**：持有锁（含自动接管）的窗口写目标文件不受拦。
- **未认领文件**：不拦截（允许自由写），靠审计兜底（§8）。
- 拦截不依赖 agent 自律：即使模型忘了查板，写入也会被挡。

## 8. 审计与冲突检测

- **数据源**：`fs/observed` 事件（每次写入后的观察，携带 target 与 actor）+ 插件主动登记（claim/done 时记录）。
- **落盘**：追加写 `.dsh/collab/activity.log`，一行一条：

```
2026-08-15T12:03:00+08:00 窗口A claim  登录接口 files=[src/auth.ts]
2026-08-15T12:10:00+08:00 窗口B denied src/auth.ts (locked by A, queued #1)
2026-08-15T12:15:00+08:00 窗口A done   登录接口 files=[src/auth.ts]
2026-08-15T12:16:00+08:00 窗口B take   src/auth.ts (queue head)
```

- **冲突检测**：`collab_board` 读取时扫描审计日志，发现同一文件在相近时间窗口被两个不同窗口写入（且至少一方未持有锁）→ 板子顶部标红警告 + 建议 `git diff` 人工裁决。
- 审计是兜底：预防靠拦截，兜底靠记录，双保险。

## 9. 协作纪律注入

插件用 `ctx.systemPrompt.section(...)` 给所在窗口注入协作规则段落，内容要点：

1. 收到用户派活 → 先调 `collab_board` 查板（有无冲突、有无他人认领相关文件）。
2. 开工 → `collab_claim <任务> <文件列表>` 认领；目标被占则入队等待，先做未锁部分。
3. 只动自己认领（或未认领）的文件；发现板上有冲突标记 → 停下问用户。
4. 完成 → `collab_done <改动文件>` 更新板子并释放锁。
5. 每回合开始、每次写文件前，刷新板子状态。

注入由插件自动完成，用户不需要手动教每个窗口。

## 10. 插件工具协议（每窗口 4 个工具）

| 工具 | 参数 | 行为 |
|---|---|---|
| `collab_board` | `--refresh` | 读板子 + 锁目录 + 审计，返回结构化状态（任务、持锁、队列、冲突警告、过期锁） |
| `collab_claim` | `<任务> <文件列表> [cancel_wait=true]` | 原子取锁；被占则入队；返回"已持有 / 已排队第 N 位" |
| `collab_done` | `<任务> [<文件列表>]` | 释放锁 → 队首接管 → 更新板子 → 追加审计 |
| `collab_status` | — | 本窗口身份字母、持锁列表、排队列表 |

> 工具名规范：模型 API 要求函数名匹配 `^[a-zA-Z0-9_-]+$`，点号非法，故用下划线。

工具注册用 `harness.registerTool(ctx, definition)`，注册挂在插件 Fiber 上（stop/update 自动清理）。

## 11. 生命周期

| 时机 | 行为 |
|---|---|
| 插件启动（apply） | 注册身份（读一次 identity.json）→ 注入纪律提示词 → 注册工具 → 挂拦截钩子 → 启动心跳 |
| 窗口活跃中 | 心跳续期；持锁者正常干活 |
| 窗口关闭 / 插件 stop | `agent/disposed` 或 effect disposer → 释放全部锁（队首接管）→ 板子更新 |
| 窗口崩溃（无事件） | 心跳过期（TTL 15 分钟）→ 队首接管，旧锁入审计 |
| DSH 重启 | 板子/锁/身份表都在磁盘上，状态不丢；插件重新 run |

## 12. 协作循环示例

```
窗口A: 用户说"写登录接口"
   A: collab_board → 无冲突
   A: collab_claim("登录接口", [src/auth.ts]) → 持有
   A: 写 src/auth.ts ... 完成
   A: collab_done → 释放，队首接管，审计登记

窗口B: 用户说"做登录页，顺便看看 auth 模块"
   B: collab_board → 看到 A 锁了 src/auth.ts
   B: collab_claim("登录页", [src/pages/login.tsx]) → 持有
   B: 写 src/pages/login.tsx ✓（未锁文件放行）
   B: 尝试改 src/auth.ts → 拦截："已被窗口A锁定，你已排队第1位"
   B: 先做登录页其他部分
   A: collab_done → 锁转给 B
   B: 下回合 collab_board → "你已接管 src/auth.ts" → 继续
```

## 13. 边界与错误处理

| 场景 | 处理 |
|---|---|
| 双窗口同时 claim 同一任务 | mkdir 原子性保证只有一个 holder，另一方入队 |
| 未认领文件被双写 | 不拦（文件自由），审计检测到多窗口写入 → 板子标红 + 建议 git diff |
| 窗口崩溃 | TTL 过期 / `agent/disposed` 事件 → 队首接管 |
| 插件自己写 .dsh/collab | 拦截钩子白名单放行 |
| 板子被用户手改 | 板子由插件重写，用户编辑会被下次工具调用覆盖；只建议用户读 |
| 锁目录残留 | 过期锁在 `collab_board` 时标记可接管并提示 |
| 身份注册竞争 | rename 原子 + 冲突重试（≤3 次） |
| 沙箱权限 | 写 `.dsh/collab/` 需要 workspace-write，会话默认策略满足 |

## 14. 实现前必须验证的点

1. **拦截钩子作用域**：`fs/write-intent` / `fs/edit-intent` 能否拦**其他会话**的写入（全局）还是会话私有；`tools.guard` 同样验证。决定 §7 用哪条路（或都不可行 → 退化为"登记制 + 板子标红"软审计）。
2. **身份获取**：动态插件 Host 侧能否拿到自己会话的 sessionId（`ctx.agents` 的 `currentInitiator()` / `agent/session-start` 事件）。
3. **事件作用域**：`fs/observed`、`agent/disposed` 在动态插件里是否能全局监听。
4. **systemPrompt.section 注入**：动态插件注入的提示词段落是否对当前 agent 生效。

## 15. 测试计划（实现后）

- 双窗口 A/B 各 run 插件 → 身份注册为 A、B，重启后字母不变。
- A 认领后 B 写同文件 → 被临时拦截 + B 入队；A done 后 B 自动接管并放行。
- B 被拦时任务不中断（板子显示"进行中 + 等待队列"）。
- 关掉 A 的窗口 → 锁立即释放（agent/disposed）或 TTL 过期后接管。
- 未认领双写 → 板子标红冲突警告。
- DSH 全重启 → 板子/锁/身份不丢。
- 插件 stop → 锁释放、工具消失、提示词段落移除、钩子摘除。

## 16. 明确不做（YAGNI，二期候选）

- GUI 状态面板（Client Slot 展示各窗口状态）
- 窗口间实时消息通道（agent 互发消息/问答）
- 宿主组合共享服务（实时层）
- 插件打包成 agent preset（新窗口自动加载）

## 17. 参考

- DSH Inspect：Host `Service.listService`（fs、tools、systemPrompt、agents、timer）、Host `Event.listEvents`（fs/write-intent、fs/edit-intent、fs/observed、agent/session-start、agent/disposed、tools/pre-execute）
- 对标：Claude Code 桌面端并行代理（https://claude.com/blog/claude-code-desktop-redesign）；社区多会话协作方案 mclaude（原子锁 + 消息 + 交接，https://github.com/AnastasiyaW/mclaude）
