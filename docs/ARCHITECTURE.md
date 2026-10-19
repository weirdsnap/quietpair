# 架构

QuietPair 是一个「结对编程伙伴」插件：守望模式实时感知用户编码并主动建议，聊天 Agent 负责对话与执行。两边共享一份项目记忆和上下文。

> 交互层的用户流（时序图/流程图）见 [USER_FLOW.md](USER_FLOW.md)；本文档聚焦模块与数据流。两份文档连同 README 在每次行为变更时一起更新。

## 模块图

```
src/
├── extension.ts            装配层：创建各模块、注册命令、接通模块间事件
│
├── core/                   基础设施（无业务逻辑）
│   ├── config.ts           设置项读取（vsAgent.*）+ API key（SecretStorage 优先）+ 输出语言指令
│   │                       （vsAgent.responseLanguage，注入聊天与守望的 system prompt）
│   │                       + 学习模式开关（vsAgent.learningMode）
│   ├── llm.ts              OpenAI 兼容流式客户端：SSE 解析、tool_calls 累积、AbortSignal、usage 回收
│   ├── usage.ts            token 统计：会话/全局累计，按来源（chat/companion/compact）细分
│   ├── telemetry.ts        埋点（schema 集中）：建议生命周期 + 模式切换事件，
│   │                       全走 logger 落 transcript（kind: metric）——评测/个性化的数据底子
│   └── logger.ts           Output 面板实时日志 + JSONL transcript 落盘
│
├── agent/                  聊天 Agent
│   ├── agent.ts            runAgent 工具循环；循环只认通用事件（token/工具/完成/打断），
│   │                       业务能力经 ToolContext 传入；连续纯读工具并发执行（groupToolCalls 分组）
│   ├── prompts.ts          所有面向模型的 prompt：SYSTEM_PROMPT（伙伴人设）+ COMPANION_PROMPT（守望分析）
│   │                       + INIT/GUIDE_PROMPT（init 两个剧本：帮我总结 / 带我读一遍）
│   │                       + LEARNING_POSTURE（学习姿态，learningMode 开启时追加到聊天 system prompt）
│   │                       + LEARNING_COMPANION（学习模式的守望指令：L1/L2 留白、L3 豁免）
│   │                       + deepenPrompt（建议卡片按需深化：展开说说 / 给个例子）——调文案只改这里
│   └── tools.ts            工具注册表：一条记录 = schema + execute + 权限标记（readonly / parallelSafe），
│                           toolDefinitions / 只读子集 / executeTool / groupToolCalls 全部从注册表派生；
│                           write_file / run_command 需审批（白名单只读命令除外），路径限制在工作区内；
│                           记忆存储/审批/分析/选项回调均由调用方经 ToolContext 注入，缺哪个能力对应工具默认拒绝
│
├── companion/              守望模式（编排层 + 决策层 + 职责模块）
│   ├── companion.ts        编排层：编辑/切换编辑器事件监听与调度，公开入口
│   │                       （手动触发 / 聊天 analyze_code / 复审 reviewFiles / 确认修复 confirmFix）
│   ├── decision.ts         开口决策层（纯函数）：「现在该不该开口」的唯一权威，汇所有门控信号为
│   │                       speak/delay/suppress 三值判定（对齐 TMLR must/may/must-not 窗口思想），
│   │                       每次判定落 transcript（phase: 'decision'）——时机评测/个性化的数据底子
│   ├── gate.ts             语义闸门（纯函数）：编辑分类决定等待时长 +
│   │                       括号配对扫描 / 光标边界检测（决策层的信号源）
│   ├── analyzer.ts         分析管线：hash 去重 + 冷却闸门 + 注入项目记忆/活动轨迹 →
│   │                       LLM（可自主调只读工具取证，≤3 轮）→ 结构化建议（含 reflect 元认知提问）；
│   │                       learningMode 开启时追加 LEARNING_COMPANION（L1/L2 留白、L3 豁免）
│   ├── triage.ts           保存分诊「速记员」（分层观测第二层）：保存时用极小调用
│   │                       判断值不值得叫醒深度分析（30s 限频，可用便宜的 triageModel）
│   ├── annotations.ts      建议画到编辑器：分级波浪线 / 悬停详情（含 reflect）/ CodeLens / 问题面板
│   └── activity.ts         活动缓冲区（分层观测第一层）：本地记录编辑/浏览轨迹，
│                           注入分析 prompt；Agent 自己的写入被排除
│
├── memory/                 记忆层
│   ├── store.ts            项目记忆 .vs-agent/memory.md（注入 system prompt，AI 可写）
│   └── sharedContext.ts    守望建议栈 → 注入聊天 prompt（「刚才那个建议」；
│                           「正在看」标记 + 卡片Discuss按钮引用解决模糊指代）
│
└── ui/
    └── chatView.ts         Webview 后端：会话历史（持久化+压缩）、审批、打断、设置页

media/
├── chat.js                 Webview 前端：消息渲染（迷你 markdown）、交互
└── chat.css                样式（全部使用 VS Code 主题变量）
```

## 数据流

**守望链路**（AI 主动开口）：

```
onDidChangeTextDocument
  → classifyDelay（删除/粘贴/语句边界 3s；普通打字 10s）
  → 语义闸门（括号配对 + 光标边界，不完备则重试 ≤3 次）
  → 哈希去重 → 冷却闸门（距上次分析 <300s 则推迟到冷却结束，复审/分诊叫醒除外）
  → LLM（COMPANION_PROMPT + 项目记忆 + 活动轨迹（activity.ts 本地统计），
    模型可自主调 read_file / list_files 取证，≤3 轮后必须产出 JSON）
  → parseSuggestions
  → annotations.set（编辑器标注 + 问题面板）
  → sharedContext.add（共享上下文）
  → 面板卡片；L3 额外弹通知 + 自动展开详情
```

**init 链路**（首次建立项目记忆，顶栏 Init 按钮 / `vs-agent.initProject` 命令）：

```
chatProvider.initProject → 选项卡（代码层确定性分支，不经 LLM）：
  A 带我读一遍 → GUIDE_PROMPT：静默探索结构 → 交付阅读地图（入口/依赖方向/
    3–5 个关键文件的阅读顺序与关注点）→ 逐站陪同（agent 读文件指重点 →
    ask_user 理解检查 → 对照代码验证 → 纠偏/确认）→ 收尾建议 10 分钟最小改动任务
    （只建议不动手）。用户确认过的理解写进「项目概况」并带「✅ 用户确认」前缀，
    与 agent 推断的条目区分可信度
  B 帮我总结 → INIT_PROMPT：Agent 用 list_files / read_file 探索项目
    → update_memory 写入「项目概况」等分区
  C 我已熟悉 → 跳过（不发 LLM 请求）
之后守望分析与聊天都自动带上这份记忆
```

**聊天链路**（用户开口）：

```
用户消息 → compactIfNeeded（超长蒸馏摘要 + 记忆沉淀进 memory.md）
  → system prompt = 人设 + memory.md + 守望上下文
  → runAgent 循环（工具调用 → 执行 → 回灌，write_file/run_command 先审批；
    连续的 read_file / list_files / get_active_editor 并发执行）
  → 结束 → 若有 write_file → companion.reviewFiles 复审 → 结果推回面板
```

**修复闭环**（用户回应建议 / Agent 产出对账）：

```
用户手动编辑 → 标注降级为「待确认」（变暗保留）
  → 用户点Fixed → companion.confirmFix（绕过冷却，带「用户声称已修复 X」提示）
  → 复审通过：消除 + 面板低调确认；未通过：指出问题还在
用户点Discuss → 建议进入聊天引用 chip → 用户输入问题 → 正常聊天链路
Agent write_file → companion.reviewFiles（绕过冷却，只报与本次改动相关的问题）
  → 干净 → 标注静默消除，只记 transcript（不打扰用户）
  → L2/L3 → 自动回灌 Agent 自我修正（observerFollowUp，最多 2 轮防乒乓）
  → 到顶 → 摊牌给用户判断（唯一上升到用户面前的路径）
```

**保存分诊链路**（第二层叫醒第三层）：

```
onDidSaveTextDocument
  → 有实质变化？（哈希对比，没变跳过）→ 分诊限频 30s
  → 轻量分诊调用（可用 vsAgent.triageModel 指定便宜模型，输出仅 YES/NO）
  → YES → analyzer.analyze（绕过冷却）
  → NO / 出错 → 静默
```

**打断**：任一侧发消息即触发。用户侧通过 AbortSignal 全链路中止（流/工具循环/待审批），半成品发言标记 `[用户打断了这里]` 留存历史。

## 记忆三层

| 层 | 存储 | 记什么 |
| --- | --- | --- |
| 会话历史 | workspaceState（按工作区） | 聊过什么（超长自动压缩） |
| 项目记忆 | .vs-agent/memory.md（工作区内，可提交 git） | 结论是啥：概况/偏好/决策/进行中/禁区 |
| transcript | globalStorage/logs/*.jsonl | 一切细节（复盘用） |

## 关键设计决策

- **单会话**：一个项目一条持续线程，不做多会话（伙伴关系的连续性 > 任务隔离）
- **不做全局长期记忆**：伙伴是「这个项目的专家」，记忆边界 = 工作区
- **crash-safe，不依赖关机钩子**：`deactivate()` 不保证被调用也没时间发 LLM 请求，所以所有状态每步落盘（历史逐轮写 workspaceState、记忆随 `update_memory` 落盘、transcript 实时追加）；「整理」挂在压缩这个自然节点——蒸馏摘要时顺带把 durable 条目增量合并进 memory.md
- **上下文按需取证，而非固定注入**：守望分析固定只带当前文件 + 项目记忆 + 本地活动轨迹（零 token），是否需要看其他文件由模型自己决定（只读工具，≤3 轮）——对齐「跟 tab 补全拉开差距」的定位：判断基于项目全局视野，但不浪费 token
- **分层观测**：第一层活动缓冲区（本地，零成本，连续）→ 第二层保存分诊（轻量模型，保存时判断值不值得叫醒，输出仅 YES/NO）→ 第三层深度分析（主模型，低频 300s 冷却，带着活动轨迹开口）。便宜层替昂贵层站岗，深度层只在有价值的时刻被叫醒
- **SecretStorage 存 key**：settings.json 明文且会同步，密钥不落配置文件
- **危险操作必审批**：write_file / run_command 弹 Approve/Reject，拒绝结果反馈给模型；审批/记忆/分析回调都经 ToolContext 由装配层注入，上下文缺哪个能力，对应工具直接拒绝执行（默认安全）。权限三档（`vsAgent.permissionMode`）：`discuss` 只讨论（写工具全禁，连弹窗都不出）/ `ask`（默认，逐次审批）/ `yolo`（预授权自动通过，逐笔记 transcript）。run_command 例外：白名单内的只读命令免审批直跑——复合命令按 `|` `;` `&&` `||` 切段逐段过白名单，重定向/命令替换/后台执行整条拒，参数路径限工作区内（绝对路径/`~`/`..` 一律拒），find/git/sort 的写参数（`-delete`/`--output`/`sort -o` 等）单独拉黑；可用 `vsAgent.autoRunReadonlyCommands` 关闭。定位是「减少弹窗的便利层」，不是安全边界
- **存在即打断**：不做意图分类，用户发消息 = 打断当前任务

## 长期方向（占位，未实现）

- **打断时机的数据收集与个性化**（调研依据见 `research/proactive-agents/`，本地未提交）：Züger et al. CHI 2018 证明纯键鼠/窗口交互预测可打断性达 74.8%（超生理传感器 68.3%），但其特征权重基于通用办公场景，IDE 内子状态（写码/读码/调试/跑测试）的差异需自测。三步走：① 建议展示/接受/忽略时埋点记录上下文（距上次保存、输入节奏、是否调试中、建议类型与级别），纯日志不改变行为；② 攒量后离线交叉分析，先验证「断点对齐」在本场景是否成立；③ 信号够强才上简单模型做个性化。注意：accept/ignore 混有内容质量噪声，不能单独当时机标签（时机好 0.676 vs 反时机 0.388，但只按接受率门控误报会冲 62.5%）。L2 波浪线近零成本，可作探针主动采集标注。**约束：不微调模型**——所有主动性改进都走外部手段（prompt、门控规则、few-shot 上下文注入、廉价模型过滤层），长期依赖模型厂商自身演进。
  - **场景校准（2026-10 讨论）**：commit/push 前代码错误爆炸半径小，危险成本极低，must 窗口应很薄（仅外部副作用操作）；成本项重心转向注意力成本与**学习成本**（过早提示剥夺 productive struggle，「用户即将自己想出来」是学习场景特有的 must-not）。
  - **「写到一半」判定**：停笔时长无法区分「想完了/正在想/人离开」。硬信号走代码完整性（语法不完备、空函数体、半截表达式——gate.ts 已有雏形）；「正在想」靠阅读行为推断（滚动/光标移动/查定义）；存疑即挂起（Delayed），等保存/运行断点再投递，避免精确分类的负担。**→ 三值判定框架已落地（decision.ts，2026-10-19）**：speak/delay/suppress + 每次判定落 transcript；阅读行为信号采集仍未做。
- **语音交互（待定，2026-10 讨论）**：技术可行（VS Code Speech 扩展/webview 采集 + STT/TTS/全双工 API 均成熟），但优先级低。语音输入对「讨论模式」有真实价值（思考说出来比打字快），可作长期候选；语音输出与「不打扰」定位冲突（不可忽略、不可排队、信息密度低），若做只应作为用户显式请求的应答形态，不做主动形态。
- **建议深度分级（2026-10 讨论，依据 Hint Factory CHI 2024）**：提示深度应匹配求助类型——「下一步/语法」类给到工作示例级才有效，「逻辑调试」类高层提示就够；分级下限别设太高（工作示例级是学习甜点区，不是堕落区）；高层自然语言提示最易误导且误导最难被用户发现，L2 短提示须锚定具体代码位置保证可验证；升降级交给用户拉取（卡片加「展开说说/给个例子」入口），不靠系统猜。**→ 已落地（0.1，2026-10-19）**：建议详情卡带「展开说说 / 给个例子 / 直接给方案」阶梯按钮，学习模式下 L1/L2 的 fix 默认藏起、L3 豁免；尚未实现的是「卡住自动升级」（聊天追问计数 → 自动加深）与「按求助类型匹配默认深度」。
- **建议携带元认知问题（2026-10 讨论，依据 CodeAid CHI 2024 D2）**：自动上下文+主动建议会削弱用户的元认知活动，缓解方式是建议本身带一句反思提问（「你觉得为什么会有这个问题？」），把被省掉的思考环节补回来。**→ 已落地（0.1，2026-10-19）**：建议 JSON 增加 `reflect` 字段，展示在详情卡和编辑器悬停里。
- **学习者状态建模（2026-10-19 用户提出，长期）**：学习模式的最大翻车风险是「没有学习者模型」——prompt 写得再苏格拉底，模型默认把用户当初学者，于是反复解释粗浅概念、拿简单问题烦人（用户实测观察）。阶梯提示的深度应该按「用户对这个知识点的当前掌握度」动态定入口，而不是全局一个默认层级。
  - 调研依据：TreeInstruct 的显式状态变量（4-5 个布尔掌握度，防重复提问的消融证明相关性掉 46.6%）；SocraticLM 的学生认知状态五维（题意理解/指令理解/计算/知识掌握/求知欲）；LearnLM 的 Leveling 原则（讲解难度适配水平）。
  - 现有雏形：`.vs-agent/memory.md` 的「✅ 用户确认」条目就是原始的掌握度记录——确认过的不必再教。
  - 可能方向：① 记忆里加「掌握度」分区，按概念记录（确认过/讲过一次/用户纠正过我），注入 prompt 让模型定阶梯入口；② 信号源：用户确认的 init 理解、被接受的建议、用户的纠正、提问的深度；③ 冷启动靠 init 引导流程直接问。
  - 风险：判错水平比没有模型更糟糕（patronizing 感正是 LearnLM 被抱怨的点）；掌握度会过期（用户学了新东西）；条目粒度太细会污染记忆文件。约束不变：不微调，全走 prompt + 记忆注入。
