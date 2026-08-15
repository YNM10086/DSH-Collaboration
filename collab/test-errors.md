# Collab 插件测试 — 报错记录

> 记录每次测试过程中出现的报错：现象、上下文、排查过程、结论/处理。
> 追加方式：每次新报错按时间顺序追加一节。

---

## 报错 1：collab 工具全部 unknown tool（插件实例未挂载）

- **时间**：2026-08-15（本地 09:3x，UTC 01:3x）
- **窗口**：B（session-0aced974-961b-4245-a99a-3ed38225a7bf）
- **现象**：
  ```
  collab_board --refresh  →  Error: unknown tool "collab_board"
  collab_status            →  Error: unknown tool "collab_status"
  ```
  即插件注册的 5 个工具（collab_board / collab_claim / collab_done / collab_status / collab_identity）全部不可用。
- **上下文**：
  - 插件源码已更新为 v2.0（`collab/plugin-host.js`，30271 字节，含 collab_identity 工具；git 状态 Modified 未提交）
  - activity.log 显示 01:29:18.276Z 还成功执行过 `B identity assigned window B`（collab_identity 生效），此后插件实例消失
  - 本会话为恢复会话（session-0aced974...），动态插件是会话私有内存态，恢复后不自动重挂载
- **排查**：
  - 插件源码中工具定义齐全（v2.0，第 411-539 行 defs 数组，含 5 个工具）
  - 工作区状态正常：`.dsh/collab/identity.json` = {"session-0aced974...": "B"}，board.md 无认领，两个遗留锁（src_auth.ts / src_pages_login.tsx）均为 released 残留
  - 宿主 preset 为 standard（`config/agent-presets/standard/agent.cordis.yml`），**不含 tool-cordis**（cordis_define/cordis_run 只在 cordis preset 中提供），因此当前会话无法自行重新挂载动态插件
  - 旧版插件残留 `~/.dsh/collab/`（00:46 时代，identity = A），已不相关（新版写工作区 `.dsh/collab/`）
- **结论**：插件实例需重新挂载。当前会话无 cordis 工具，挂载需宿主侧操作（切 cordis preset / 用户重新执行挂载 / 或等待宿主组合自动挂载机制）。
- **状态**：✅ 已恢复（用户宿主侧重新挂载插件后可用，见报错 2）

---

## 报错 2：身份被覆盖为 A（collab_identity 指定 B 失效）

- **时间**：2026-08-15（UTC 04:06-04:09）
- **窗口**：B（session-0aced974-961b-4245-a99a-3ed38225a7bf）
- **现象**：
  - 用户宿主侧重新挂载插件后（04:06:14 `? register`），本窗口身份从 B 变成 A
  - 工作区 `.dsh/collab/identity.json` 被改写为 `{"session-0aced974...": "A"}`（01:29 时还是 B）
  - `collab_status` / `collab_identity` 均返回"窗口A"
- **排查**：
  - activity.log 显示 04:06:23 有 `A identity assigned window A`（collab_identity 调用），随后 04:06:29-04:07:21 该实例以 A 身份认领→修改→释放了 `games/snake/snake-exe/Program.cs`
  - 该实例只改了难度部分（EASY/NORMAL/HARD_MS 档位、难度下拉框、OnDifficultyChanged），未触碰蛇绘制（窗口B 的活），无冲突
  - 注册表中只有本 session 一条记录，无法确定该调用来自哪个窗口/宿主侧操作
- **处理**：`collab_identity letter=B` 重新指定，✅ 已恢复窗口 B
- **备注**：A 的 C# 难度设置已入 Program.cs（8992 字节），释放正常；A 是"难度设置"任务的正确执行者，行为符合协作分工

---

## 报错 3：身份互覆根因确认（fork 窗口共用 sessionId）→ v2.1 修复

- **时间**：2026-08-15（UTC 04:1x）
- **窗口**：A + B（诊断者：窗口A）
- **现象**：窗口A 的 `collab_identity` 显示"本窗口身份：B"——注册表里 A 的 key 也被 B 覆盖，双向互覆。
- **根因（铁证）**：
  - B 窗口持久化会话 id 是 `43f9e831`，但其插件通过 `agents.currentInitiator().id` 读到的 sessionId 是 `0aced974`（与 A 相同）——**B 是从 A 会话 fork 出来的窗口，共享父会话 id**
  - 身份注册表以 sessionId 为 key → 两个窗口写同一个 key → 后写者覆盖先写者（A 写 A → B 看到变 A → B 写 B → A 看到变 B）
  - 04:06 的"身份被覆盖为 A"正是 A 窗口 04:06 执行 `collab_identity letter=A` 所致（B 的 key 被 A 覆盖）；B 04:09 写回 B 又覆盖了 A
- **修复（v2.1）**：注册表 key 改为 `sessionId#窗口实例token`（token 每次插件启动随机生成），窗口实例级唯一，互不覆盖；旧格式条目自动迁移清理。
- **状态**：✅ 已修复并验证（A 的 key = `session-0aced974...#mtq77b`，身份 A 稳固）
- **待办**：B 窗口需重新部署 v2.1 并 `collab_identity letter=B` 绑定

---

## ✅ 验证：写被锁文件被拦截（预期行为，非报错）

- **时间**：2026-08-15（UTC 05:13 前后）
- **窗口**：B（session-43f9e831...，v2.1 bundle 常驻模式）| **插件版本**：v2.1
- **场景**：窗口 A 认领 `games/snake/game.js`（任务"网页版游戏编译调试"，锁约 2 分钟），窗口 B 尝试写入
- **结果**：
  ```
  Error: ⛔ D:\Constantly-evolving\games\snake\game.js 已被窗口A认领（网页版游戏编译调试（A 持有中，勿动））。用 collab_board --refresh 查看板子，或用 collab_claim 传入 cancel_wait=true 退队。
  ```
  - ✅ pre-execute deny 生效，edit 被拒绝
  - ✅ 文件未被修改（搜索测试标记 0 匹配）
  - ✅ 审计留痕（guard-check）
- **结论**：写被锁文件 → 拦截路径验证通过（v2.1 bundle 常驻下 pre-execute 拦截正常）
- **备注**：报错 3 的待办已完成——本窗口已部署 v2.1 且身份为 B（`collab_status` 显示 key `session-43f9e831...#ywp959` = 窗口B）

---

## ✅ 验证：认领被占 → 排队 → 释放后自动交接（预期行为，非报错）

- **时间**：2026-08-15（UTC 05:16-05:19）
- **窗口**：B | **插件版本**：v2.1
- **场景**：窗口 A 持有 `games/snake/game.js`（模拟编译调试锁约 2 分钟），窗口 B 认领该文件
- **结果**：
  - B claim → `⏳ games/snake/game.js: 已被窗口A持有，你已排队第 1 位（释放后自动接管）`
  - 锁文件：`holder=A, queue=["B"], released=false`；`collab_status` 排队第 1 位 ✓
  - A 释放（`A done games/snake/game.js handover to B`）→ 锁文件 `holder=B, queue=[]`，claimedAt/heartbeat 刷新 ✓
  - B `collab_status`：持锁 games/snake/game.js，排队无 ✓
  - B `collab_done` 释放 → `✅ 已释放`（无队列，直接 released）✓
- **审计链**：`B queue ... position 1` → `A done ... handover to B` → `B done ... released`，全程留痕 ✓
- **结论**：排队 + 自动交接路径验证通过（v2.1 无回归）
