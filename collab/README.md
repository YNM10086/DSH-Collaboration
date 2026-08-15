# DSH Collab 插件 — 使用说明

多窗口同项目协作：共享任务板 + 文件认领锁（排队接管）+ 写入拦截（防肘击）+ 审计日志。

## 两种模式

| 模式 | 何时用 | 怎么开 |
|---|---|---|
| **bundle 常驻**（推荐） | 已装进 profile，宿主启动自动加载，所有窗口自动有工具，重启不丢 | 无需操作（`dsh plugin add` 装过一次即可） |
| **按需开启** | 不想装 bundle / 临时用 / bundle 出问题时 | 任何窗口说 **"开启并行模式"** → 窗口立即用动态插件挂载（见下） |

> 无论哪种模式，**窗口身份都由用户指定**：对窗口说"你是X"，窗口执行 `collab_identity letter=X` 确认。

## 按需开启（动态插件版）

窗口收到"开启并行模式"指令后：

1. 读 `collab/plugin-host.js`（v2.1，它就是 `code.host` 函数体）
2. `cordis_define`（kind: "new"，idPrefix: "collab"）+ `cordis_run`
3. `collab_identity letter=X` 绑定身份

立即可用、无需重启；但**进程重启后需要重新挂载**（动态插件进程级）。

## bundle 部署与源码同步

```sh
# 首次安装
dsh plugin --profile web add "file:D:/Constantly-evolving/collab-bundle"
# 改过 collab-bundle/ 源码后【必须】同步副本（pnpm file: 依赖是复制不是链接！）
powershell -File collab/sync-bundle.ps1
# 然后重启 DSH
```

**血泪教训**：pnpm 的 file: 依赖不会自动同步源码——改 `collab-bundle/lib/index.js` 后直接重启，加载的永远是 node_modules 里的旧副本。改代码后务必先跑 `sync-bundle.ps1`。

## 工具

| 工具 | 用途 |
|---|---|
| `collab_board --refresh` | 查任务板（持锁/排队/冲突警告），顺带刷新锁状态 |
| `collab_claim <任务> <文件列表>` | 认领文件；被占则自动排队（不取消任务）；`cancel_wait=true` 退队 |
| `collab_done [文件列表]` | 完成任务释放锁，锁交接给队首（不传 files = 释放全部） |
| `collab_status` | 本窗口身份、持锁、排队情况 |

## 协作纪律（插件自动注入提示词）

1. 收到派活先 `collab_board` 查板
2. 开工前 `collab_claim` 认领；被占则排队等待，先做未锁部分
3. 只写自己认领或未认领的文件；写被锁文件会被**拦截**（返回拒绝原因）
4. 完成时 `collab_done` 释放并登记
5. 每回合开始、每次写文件前，先 `collab_board --refresh`

## 文件布局

```
.dsh/collab/
  board.md          # 任务板（人可读，派生视图）
  identity.json     # 身份注册表（sessionId → 字母）
  activity.log      # 审计日志（认领/拒绝/写入观察）
  locks/            # 锁文件（唯一事实源）
```

## 调试

`unpack-session-log.mjs`：解压 DSH 会话日志（zstd 多帧），排查崩溃/回合错误：
`node collab/unpack-session-log.mjs`

## 已知边界

- 拦截只覆盖模型文件工具（write/edit）的执行路径；shell 直接写文件不受拦，靠审计兜底
- 守卫使用内存镜像 + 周期刷新（60s 心跳），刚写入的锁最多延迟到下次 `collab_board --refresh` 生效
- 插件更新（update）会触发旧实例清理：释放本窗口全部锁（设计行为）
