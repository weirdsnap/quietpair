# 已知问题记录

2026-11-22 全面代码体检的发现汇总。每条含：场景、触发手段、根因定位、预计方案。
按优先级分级：🔴 P1 用户可感知故障，尽快修；🟡 P2 集成缝隙，该修但不急；⚪ P3 小瑕疵，记录即可。
修复完成后从本文档移除（或移入文末「已修复」存档区），保持清单只含活问题。

---

## 🟡 P2-3　确认修复找到锚的新位置后，编辑器标注不随行

**场景**：建议锚定的代码被用户**原样移动**到同文件其他位置（比如把函数挪到文件底部），点 Fixed 后判定正确（锚匹配成功，报「修复已确认」），但编辑器里的红色波浪线/标注仍钉在旧行号上——视觉上指着无关代码，要等下一次分析才刷新。

**触发手段**：对一条有行号的建议，把它指向的代码块整体剪切粘贴到同文件另一处（内容不变），点 Fixed → 判定对，但波浪线位置是旧的。

**根因**：锚一期落地时（见 [design/suggestion-identity.md](design/suggestion-identity.md)），`confirmFix` 找到锚的新位置只用于判定结论，**没有回写 annotations 的行号**。标注的刷新完全依赖下一轮分析。

**预计方案**：两条路径——① 轻量修补：confirmFix 找到锚新位置时回调更新 annotations 对应条目的行号；② 根治：二期「SharedContext 身份键换锚」落地时，标注位置天然跟随身份。倾向先在二期设计里记为已知项，若用户反馈频繁再做 ①。

---

## ⚪ P3-1　init 选项卡挂着时按 ■ 打断无效

**场景**：init 流程弹出「How would you like to start?」选项卡、且当前没有 Agent 运行在跑时，用户按 ■ Stop 想取消——没有任何反应，只能点选项卡上的选项才能继续。

**根因**：`src/ui/chatView.ts:539-554` — `requestChoice` 的 abort 监听挂在 `this.currentAbort` 上；init 弹选项卡发生在 run 开始之前，`currentAbort` 为 null，监听从未注册，Promise 只能被点选解决。

**预计方案**：选项卡本身加「取消」选项（init 已有 Cancel，但 ask_user 工具弹的卡没有），或 stopRun 时也 resolve 所有 pendingChoices（视为「未做选择」）。优先级低：现状只是 UX 不顺畅，不会卡死。

---

## ⚪ P3-2　ActivityTracker.opens 无界增长

**场景**：超长会话（VS Code 连续开几天），每次切换编辑器标签都往 `opens` 数组 push 一条，从不修剪——几千上万条小对象累积。

**根因**：`src/companion/activity.ts:52` — push 无上限；`summarize()` 只读 15 分钟窗口内的条目，但数组本身不清理。

**预计方案**：push 时顺手截断（保留最近 N 条或删掉窗口外前缀）。无害不紧急，下次动 activity.ts 时顺带修。

---

## 体检中确认健康的部分（2026-11-22）

- 前后端消息协议双向完全对齐（chat.js 发出 21 种 / 接收 24 种，contract test 强制）
- ImportGraph 双向索引增删维护正确；EditTracker 有界（1000 文件上限）
- SendQueue 与自动压缩的交互安全（interrupt 能停掉压缩；压缩期入队消息会等待而非丢失）
- `clear()` 对 running 任务的等待逻辑正确（幽灵气泡问题只在手动压缩这条漏网路径，即 P2-1）

---

## 已修复存档

### 2026-11-22　P1-1 打断多组工具调用毁 history
- **原问题**：组间 abort 时 assistant 消息带着全部 tool_calls 先入 history，未执行的调用永远缺 tool 响应 → 下一轮请求被 API 整个拒绝，只能 Clear 恢复。
- **修复**：`agent.ts` 组间 abort 返回前为未答复的 tool_calls 补占位 tool 消息（`[interrupted by user — tool not executed]`）。
- **门禁**：`tests/stubbed/agent.test.ts` —— 不变量断言「history 里每个 tool_call 必有 tool 响应」。

### 2026-11-22　P1-2 git branch/tag 白名单方向反了
- **原问题**：branch/tag 用黑名单式检查，但它们是默认写的命令（`git branch foo` / `git tag v1.0` 不带 flag 就是创建），创建操作免审批直放。
- **修复**：`tools.ts` 改白名单式（`isGitListOnly`）——只放行裸列举与纯列举 flag 组合，两个命令的 flag 集合分开定义（`-a` 在 branch 是列举、在 tag 是创建）。
- **门禁**：`tests/stubbed/tools.test.ts` 新增 9 拒 10 放用例矩阵。

### 2026-11-22　P2-1 手动压缩 × Clear 竞态
- **原问题**：`compactNow()` 不传 signal 不设 currentAbort，clear 无法打断；压缩完成后把旧摘要塞回已清空的 history。
- **修复**：`compactNow()` 纳入同一套打断语义（currentAbort + signal）；`clear()` 发现压缩进行中时打断并经 compactWaiters 等其收尾；`compactIfNeeded` 覆写 history 前加最后一道 abort 闸。
- **门禁**：`tests/stubbed/chatView.test.ts` —— 压缩挂起 → clear → 放行压缩，断言 history 只剩 system。

### 2026-11-22　P2-2 memory.md 手动编辑缓存不刷新
- **原问题**：`MemoryStore.invalidate()` 无调用方，外部编辑后 system prompt 一直注入旧记忆。
- **修复**：`extension.ts` 挂 FileSystemWatcher（`**/.vs-agent/memory.md` 的 change/create/delete → invalidate）。
- **门禁**：`tests/stubbed/store.test.ts` —— 缓存命中 / invalidate 后读到新内容 / write 刷新缓存。
