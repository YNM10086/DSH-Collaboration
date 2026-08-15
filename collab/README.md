# DSH Collab 插件 — 使用说明

多窗口同项目协作：共享任务板 + 文件认领锁（排队接管）+ 写入拦截（防肘击）+ 审计日志。

## 每个窗口都要做的事

动态插件是会话私有的——**每个窗口各跑一份**。在新窗口里：

1. 读取本文件同目录的 `plugin-host.js`（它就是 `code.host` 的函数体）
2. 调 `cordis_define`：`kind: "new"`，`idPrefix: "collab"`，`code.host` = 文件内容
3. 调 `cordis_run` 激活

窗口自动注册身份（A、B、C……，注册表 `.dsh/collab/identity.json`，重启复用）。

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
