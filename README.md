# DSH Collab — 多窗口同项目协作插件

让多个 DeepSeek Harness（DSH）窗口在**同一个项目**里并行编码、互相沟通、**不互相肘击**——对标 Claude Code 的多窗口并行协作体验。

```
窗口A: 🔒 认领 games/snake/game.js → 编译中...
窗口B: ✍️ 尝试写 game.js → ⛔ 已被窗口A认领（已排队第1位）
窗口A: ✅ 释放 → 锁自动交接给窗口B → B 继续写
```

## 核心能力

- **共享任务板**：`.dsh/collab/board.md`，实时显示各窗口持锁/排队/冲突状态（锁目录为唯一事实源，板子为派生视图，自愈式重建）
- **文件认领锁**：开工前 `collab_claim` 认领文件，被占自动**排队等待**（任务不取消），释放后**队首自动接管**
- **写入拦截**：写被其他窗口认领的文件会被 **`tools/pre-execute`** 直接拒绝（`⛔` 提示 + 排队信息），防肘击
- **审计日志**：`activity.log` 记录认领/拒绝/写入观察，冲突标红提醒
- **用户指定身份**：对窗口说"你是X"，执行 `collab_identity letter=X` 立即绑定（fork 窗口共享 sessionId 也互不干扰）
- **双模式部署**：bundle 常驻（宿主级，重启不丢）或按需动态挂载（"开启并行模式"口令）

## 快速开始

### 模式一：bundle 常驻（推荐）

```sh
# 1. 安装到你的 profile（把 D:/Constantly-evolving 换成你的仓库路径）
dsh plugin --profile web add "file:D:/Constantly-evolving/collab-bundle"

# 2. 重启 DSH —— 所有窗口自动获得 collab 工具
```

### 模式二：按需动态挂载（不装 bundle）

任何窗口说 **"开启并行模式"**，窗口读取 `collab/plugin-host.js` 执行 `cordis_define` + `cordis_run` 立即挂载（进程重启后需重新挂载）。

### 绑定身份

```text
对窗口说：你的身份是 A
窗口执行：collab_identity letter=A   （被占用可 force=true 接管）
```

## 工具一览

| 工具 | 用途 |
|---|---|
| `collab_board --refresh` | 查任务板（持锁/排队/冲突警告） |
| `collab_claim <任务> <文件列表>` | 认领文件；被占自动排队；`cancel_wait=true` 退队 |
| `collab_done [文件列表]` | 完成任务释放锁，交接给队首 |
| `collab_status` | 本窗口身份、持锁、排队 |
| `collab_identity [letter=X] [force]` | 查询/指定本窗口身份 |

## 适配到你的环境

1. **克隆**：`git clone git@github.com:YNM10086/DSH-Collaboration.git`
2. **装 bundle**：`dsh plugin --profile <你的profile名> add "file:<仓库路径>/collab-bundle"`
3. **重启** DSH，新会话直接可用
4. **改插件源码后**（关键坑）：pnpm 的 file: 依赖是**复制不是链接**，必须同步副本再重启：
   ```sh
   powershell -File collab/sync-bundle.ps1
   # 或手动：删 node_modules/dsh-collab-bundle 后在 profile 目录跑 pnpm install
   ```
5. **验证**：任意窗口执行 `collab_status`，身份用 `collab_identity letter=X` 指定

> 需要 DSH 版本：基于 `@deepseek-ai/dsh` 的 profile（web/headless 均可）；bundle 模式依赖 dsh-base 类 profile 提供的 fs/agents/sessions/tools/sandboxPolicy/systemPrompt/timer 服务。

## 目录结构

```
├── collab/                  # 动态插件版（v2.1，按需挂载）
│   ├── plugin-host.js       #   code.host 函数体（cordis_define 直接使用）
│   ├── README.md            #   详细使用说明（双模式、坑）
│   ├── sync-bundle.ps1      #   bundle 副本同步脚本（改源码后必跑）
│   └── unpack-session-log.mjs  # DSH 会话日志（zstd）解码调试工具
├── collab-bundle/           # bundle 版（v3.0.1，宿主组合插件）
│   ├── lib/index.js         #   宿主插件（per-agent 身份、pre-execute 拦截）
│   └── cordis.patch.yml     #   bundle patch（dsh plugin add 自动应用）
├── games/snake/             # 演示项目：贪吃蛇（exe 版 + 网页版）
│   └── Snake.exe            #   编译产物（csc 编译，零依赖）
└── docs/superpowers/specs/  # 设计文档
```

## 已验证（真实双窗口测试）

- ✅ 认领 → 写被锁文件被 `⛔` 拦截（文件未被修改）
- ✅ 被占 → 排队第 1 位（任务不取消）→ 释放 → **队首自动交接**
- ✅ 身份用户指定，fork 窗口（共享 sessionId）互不覆盖
- ✅ bundle 宿主重启后自动恢复（无需手动挂载）
- ✅ 审计日志完整留痕（claim/denied/guard-check/observed）

完整测试记录见 [collab/test-errors.md](collab/test-errors.md)（含历次报错与根因）。

## 已知边界

- 拦截覆盖模型文件工具（write/edit）的执行路径；shell 直接写文件不受拦（靠审计兜底）
- 拦截依赖窗口内存镜像，新锁最多延迟到 `collab_board --refresh` 或心跳（60s）后生效
- 动态插件模式进程重启即失（bundle 模式无此问题）
- 身份注册表残留条目暂不自动过期（字母用尽时可手动 `force` 接管）

## 许可证

Apache-2.0。参考项目：[dsh-background-agents](https://github.com/PerryLink/dsh-background-agents)（其 bundle 部署/Config/持久化模式为本项目 v3.0 提供设计参考）。
