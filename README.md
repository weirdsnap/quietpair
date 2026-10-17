# QuietPair

一个 AI 结对编程伙伴 VS Code 插件（TypeScript）
因为助手类型的AI agent已经很多了，xx code 或者龙虾那些全能的智能助手。
但是我想的如果有时候我们需要一些不仅是下达一个命令，然后等待他的工作，而是能够在我工作的时候，主动的观察我们的工作区，就好像一个看着你的屏幕的结对搭档。但是也不同于快速的补全那种，他会更加的了解整体的项目，你们也可以随时的讨论。
**守望模式**实时感知你正在编辑的代码并主动推送建议，同时保留侧边栏聊天 Agent 可随时提问。

## 环境要求

- Node.js（本项目使用 v26.8.1）
- VS Code ^1.95.0
- 一个 OpenAI 兼容接口的 API key（OpenAI、DeepSeek、Kimi 等均可）

## 项目结构

```
vs_agent/
├── package.json               # 插件清单：命令、配置项、侧边栏视图声明
├── tsconfig.json              # TypeScript 配置
├── src/
│   ├── extension.ts           # 入口：注册 webview 视图、命令、守望模块
│   ├── core/                  # 基础设施：与业务无关的底层能力
│   │   ├── config.ts          # 读取配置项（baseUrl/model）+ SecretStorage 存取 API key
│   │   ├── llm.ts             # OpenAI 兼容的流式 chat completions 客户端（SSE 解析，支持 AbortSignal，回传 token 用量）
│   │   ├── usage.ts           # Token 消耗统计：会话级 + 全局累计，按来源（聊天/守望/压缩）细分
│   │   └── logger.ts          # 双通道日志：Output 面板实时日志 + JSONL transcript 落盘复盘
│   ├── agent/                 # 聊天 Agent：对话与工具执行
│   │   ├── agent.ts           # Agent 循环：发消息 → 收工具调用 → 执行 → 回灌结果（连续纯读工具并行）
│   │   ├── prompts.ts         # 所有面向模型的 prompt：伙伴人设 + 守望分析人设（调文案只改这里）
│   │   └── tools.ts           # 工具注册表：schema + 执行 + 权限标记一条记录，加工具只需加一条
│   ├── companion/             # 守望模式：被动观察、主动建议
│   │   ├── companion.ts       # 编排层：事件监听/调度，公开入口（手动触发/聊天请求/复审/确认修复）
│   │   ├── gate.ts            # 语义闸门（纯函数）：编辑分类决定等待时长 + 括号配对/光标边界检测
│   │   ├── analyzer.ts        # 分析管线：注入记忆与活动轨迹 → LLM（可自主取证）→ 结构化建议
│   │   ├── triage.ts          # 保存分诊「速记员」：保存时用极小调用判断值不值得叫醒分析
│   │   ├── activity.ts        # 活动缓冲区：本地记录编辑/浏览轨迹（零 token），供分析注入
│   │   └── annotations.ts     # 编辑器内标注：分级 Decoration + 悬停详情 + CodeLens + 问题面板诊断
│   ├── memory/                # 记忆：会话历史、项目记忆、共享上下文
│   │   ├── store.ts           # 会话历史持久化（workspaceState）+ 项目记忆文件（.vs-agent/memory.md）+ 压缩
│   │   └── sharedContext.ts   # 守望 ↔ 聊天共享上下文栈（「刚才那个建议」）
│   └── ui/
│       └── chatView.ts        # 侧边栏 Webview provider：聊天、建议卡片、审批交互
├── media/
│   ├── icon.svg               # 活动栏图标
│   ├── chat.js                # 聊天界面前端逻辑
│   └── chat.css               # 聊天界面样式（跟随 VS Code 主题变量）
├── docs/
│   ├── ARCHITECTURE.md        # 模块划分、数据流与关键设计决策
│   └── USER_FLOW.md           # 用户流（mermaid）与用户故事：每次行为变更需同步更新
├── .vscode/
│   ├── launch.json            # 调试配置（F5 启动）
│   └── tasks.json             # 自动编译任务
└── out/                       # 编译产物
```

分目录原则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：`core` 不依赖任何业务模块，`companion`/`agent` 互不直接依赖，通过 `memory/sharedContext.ts` 交换信息，`ui` 只做展示与交互转发。

## 守望模式（Companion）

核心能力：你在写代码，AI 在旁边看着，停笔片刻后自动分析并把建议直接标注在编辑器里。

- **触发（三条路径）**：
  - **编辑分类决定等待时长**：删除（可能在重构）、粘贴大块代码（≥50 字符）、空行分段、语句边界 token（`;` `}` `)` `=>` `return`）→ 快速触发（默认 3 秒）；普通打字 → 常规防抖（默认 10 秒）
  - **保存分诊（分层观测第二层）**：用户主动保存文件 → 一次极小的分诊调用（输入几百 token、只输出 YES/NO，可用 `vsAgent.triageModel` 指定更便宜的模型）判断「值得叫醒深度分析吗」——改动量大/结构性修改/有诊断错误才叫醒，纯格式化或微调就放过。分诊本身限频 30 秒
  - **手动触发**：对话里说「帮我分析一下」→ Agent 调 `analyze_code` 工具走完整守望管线（结果标注到编辑器并回给模型讨论）；面板Analyze按钮或命令则跳过所有闸门直接分析（测试用）
- **语义完备性闸门**：计时器触发后不直接调 LLM，先检查当前状态是否「说完了」——全文件括号配对扫描（识别字符串/模板串/行注释/块注释，避免被字符串里的括号误导）+ 光标行是否停在语句边界（空行、`;{}:,` 结尾、注释行）。不完备则 3 秒后重试，最多 3 次；完备才真正调用模型。AI 的「插话」时机更像真人结对：你写完一个句子，对方才开口
- **上下文**：当前文件内容（截断至 40000 字符）、语言、行数、该文件的诊断信息（错误/警告）、**用户最近 15 分钟的活动轨迹**（本地统计：编辑过哪些文件各增删多少字符、打开看过哪些文件，Agent 自己的写入会被排除），并注入项目记忆（`.vs-agent/memory.md`）。**是否需要看项目里其他文件由 AI 自己决定**——分析时挂着只读工具（`read_file` / `list_files`），模型拿不准可以自主取证（比如确认函数定义、检查调用方），最多 3 轮，不能改任何东西
- **结构化分析**：模型返回 JSON（行号 + 级别 + 标题 + 说明 + 可选修复代码），最多 5 条按重要性排序
- **分级推送**（模型输出 `level` 字段，本地按级别分流）：
  | 级别 | 含义 | 呈现方式 | 打断 |
  | --- | --- | --- | --- |
  | L1 观察 | 风格建议、可优化写法 | 仅 CodeLens 挂在行上方 | 否 |
  | L2 提醒 | 潜在 bug、类型不匹配、已弃用 API | 黄色波浪线 + 悬停详情 + CodeLens + 进问题面板（Warning） | 弱打断 |
  | L3 打断 | 明显错误、编译/运行会失败、安全漏洞 | 红色波浪线 + 问题面板（Error）+ 系统通知 + 自动在面板展开详情 | 是 |
- **编辑器内交互**：每条建议带三个操作按钮（CodeLens 图标 + 悬停链接都有）：
  | 操作 | 行为 |
  | --- | --- |
  | ✓ 改好了 | 用户手动改完点一下 → LLM 绕过冷却立刻复审 → 确实修好：消除警示 + 面板低调确认；没修好：指出问题还在；文件没变化时不白调 LLM——现有标注就是最新判断，直接说明（ transcript 全程记录三种结局） |
  | 🔧 帮我改 | 转给聊天 Agent 自动修改（写文件仍需审批） |
  | 讨论 | 一键把这条建议带进聊天引用 chip，用户输入问题即可讨论 |
  悬停显示完整 AI 分析与修复参考
- **待确认状态**：用户编辑文件后，该文件的标注不直接消失，而是变暗降级为「待确认」（退出问题面板、CodeLens 标「待确认：」前缀），等下一次分析刷新或用户点 ✓ 确认——标注是有新鲜度状态的观察，不是一次性通知
- **面板内追问**：建议卡片右上角有Discuss按钮——点击把这条建议引用到输入框（输入框上方出现可移除的引用 chip），发送时引用内容随问题一起给模型，指代从「猜」变成显式。点「在面板中查看」/ L3 自动展开的条目会在共享上下文里打上「用户正在看这条」标记，直接问「什么意思」模型也能对上号
- **守望 ↔ 聊天上下文共享**（`src/memory/sharedContext.ts`）：
  - 守望发现的建议写入共享上下文栈，注入聊天 Agent 的 system prompt——用户可以直接问「刚才那个建议什么意思」「帮我改一下标红的那行」
  - 聊天 Agent 每次 `write_file` 都会被记录，任务结束后守望模式立刻对被改文件做**闭环复审**（`reviewFiles`），全程在 Agent 内部完成、不打扰用户：复审干净（只有 L1 或没问题）→ 标注静默消除，只记 transcript；发现 L2/L3 → 自动回灌给聊天 Agent 自我修正（Agent 可继续修或解释理由），最多自动来回 2 轮防乒乓；只有到顶还没通过，才把问题摊开给用户判断。复审 prompt 只报与本次改动相关的问题，不翻旧账
- **双向打断**（结对编程式对话，谁都可以插话）：
  - AI → 用户：L3 级问题主动弹通知 + 自动展开详情
  - 用户 → AI：Agent 运行中输入框不锁定——直接发新消息即打断当前任务并插话；发送按钮在运行中变为红色 **Stop**，空输入点击立即叫停（流式输出、工具循环、待审批操作全部中止，悬而未决的审批自动视为拒绝）
  - 打断语义对齐语音助手（barge-in）：存在即打断，不做意图分类；被打断的半成品发言留存进对话历史并标记 `[用户打断了这里]`，模型知道那是「没说完」而非「说完了」；打断后面板确认「⏹ 已停下（正在做 XX），你说，我在听」
- **面板同步**：侧边栏同时收到建议摘要卡片；模型认为没问题（空建议）则静默丢弃，不打扰
- **成本与安全控制**：
  - 内容哈希去重——内容没变不重复分析
  - **冷却时间**——两次真正调 LLM 之间至少间隔 N 秒（默认 300）；写写停停时冷却期内的触发不丢弃，而是推迟到冷却结束用最新内容分析；复审 Agent 产出、保存分诊叫醒、✓ 确认复审不受冷却限制
  - 编辑文件时标注降级为「待确认」（变暗保留），由新分析或「✓ 改好了」复审刷新，而不是直接清除
  - 聊天 Agent 运行期间暂停分析，避免并发请求
  - 新一轮分析会 abort 掉上一次未完成的请求
  - 可在面板底部点 Watch 随时开关；点顶栏 Analyze 立刻手动分析当前文件（跳过防抖/冷却/哈希去重，方便测试），或命令 `QuietPair: Analyze Current File Now`
- **配置项**：
  - `vsAgent.companion.enabled`（默认 `true`）
  - `vsAgent.companion.debounceSeconds`（普通打字防抖，默认 `10`，最小 `3`）
  - `vsAgent.companion.quickTriggerSeconds`（语义触发防抖，默认 `3`，最小 `1`）
  - `vsAgent.companion.cooldownSeconds`（两次 LLM 分析的最小间隔，默认 `300`，最小 `10`）
  - `vsAgent.companion.saveTriage`（保存时的轻量分诊，默认 `true`）
  - `vsAgent.triageModel`（分诊用的便宜模型，留空复用主模型）

## 聊天 Agent

- **人格设定**：结对编程伙伴，不是听命干活的工具——先讨论方案再动手，有自己的判断并会直接表达，但用户做了决定就尊重；用户明确要求「你去改/你去跑」时才执行写文件、跑命令这类操作，拿不准会问一句

- **对话界面**：活动栏图标 → Chat 面板，流式输出
- **接口配置（Webview 内设置页，对齐 Cline/Kilo 的形态）**：面板底部 Settings 打开内置设置视图——Provider 预设下拉（OpenAI / DeepSeek / Kimi / 自定义）、Base URL、Model、API Key 密码框、回答语言（中文/English，对应 `vsAgent.responseLanguage`）、学习模式开关（`vsAgent.learningMode`）、守望模式开关与防抖参数。Key 保存时直写 SecretStorage（系统级加密），不落任何配置文件；清空后保存即删除。VS Code 原生设置页（`vsAgent.*`）作为后备仍然可用，其中 `vsAgent.apiKey` 明文项不推荐（会被 Settings Sync 同步）
- **学习模式（可选，默认关）**：开启后聊天 Agent 叠加引导式教学姿态（`LEARNING_POSTURE`）——不直接给完整答案/修复代码，用提问引导你自己定位；概念困惑允许简短解释但解释后回扣引导问题；答错暗示方向、答对确认推进；一次只问一个问题。**制衡条款**：连续卡住或明确说「直接告诉我」时逐级加深直至给出答案，直接要求给答案/改代码时尊重照做——学习姿态是默认姿态而非封锁（设计依据：LearnLM 的教学指令遵循 + SocraticLM 的 Dean 审核准则，见 research/DISCUSSIONS.md）
- **Agent 工具**（function calling，模型自主调用）：
  | 工具 | 作用 | 需审批 |
  | --- | --- | --- |
  | `read_file` | 读工作区文件 | 否 |
  | `list_files` | 按 glob 列文件 | 否 |
  | `get_active_editor` | 获取当前打开文件/选中代码 | 否 |
  | `analyze_code` | 对话中触发守望深度分析（默认当前编辑器文件），结果标注到编辑器并回给模型讨论 | 否 |
  | `ask_user` | 给方案/选择时弹出 A/B/C 选项按钮 + 自定义输入框，挂起等用户点选后回灌给模型；被打断视为未选择 | 否 |
  | `update_memory` | 更新项目记忆文件 | 否 |
  | `write_file` | 写文件（完整覆盖） | 是 |
  | `run_command` | 在工作区根目录跑 shell 命令；白名单内的只读命令免审批直跑（ls/cat/grep/rg/find/git log·status·diff 等；管道和 && 链中每段都过白名单才放行；参数路径限工作区内；无重定向/命令替换），可用 `vsAgent.autoRunReadonlyCommands` 关掉 | 视命令而定 |
- **权限模式**（设置页或 `vsAgent.permissionMode`）：伙伴默认是顾问，动手是例外——`discuss` 只讨论：写文件/跑命令/写记忆全部被工具层直接拒绝（连弹窗都不出）；`ask`（默认）写操作逐次弹 Approve/Reject；`yolo` 写操作预授权自动通过（每次自动批准都会记入 transcript 可审计）
- **安全**：危险操作在聊天面板弹出 Approve / Reject 按钮，拒绝后结果会反馈给模型；文件路径被限制在工作区内；单次任务最多 20 步工具调用。连续的纯读工具调用（`read_file` / `list_files` / `get_active_editor`）会并行执行加速探索；写类和交互类工具（审批、选项卡）保持串行

## 记忆体系（单会话 + 项目持久记忆 + 压缩）

定位是「这个项目的结对伙伴」而非通用助手：不要全局长期记忆，不要同项目多会话。

- **单会话**：一个项目一条持续线程，历史存 `workspaceState`（按工作区隔离），重开 VS Code 接着聊；点Clear才重新开始
- **项目持久记忆**：`.vs-agent/memory.md` 存于工作区内（人类可读可改、可提交 git）。固定分区：项目概况 / 偏好与约定 / 重要决策（带日期）/ 进行中 / 禁区（用户拒绝过的建议，别再提）。内容注入聊天 Agent 和守望分析的 prompt；Agent 通过 `update_memory` 工具主动维护（整文件覆写，无需审批）
- **初始化记忆（init）**：面板顶栏点 Init 或命令 `QuietPair: Init Project Memory`，先选模式——"Guide me through it"：AI 交付阅读地图（入口/依赖方向/推荐阅读顺序），逐站陪同并用提问验证你的理解，你确认过的理解写入记忆（带 ✅ 前缀）；"Summarize for me"：Agent 自己探索整个项目，把项目概况、技术栈、目录结构、构建方式写进记忆文件。探索过程在面板里可见、可打断，完成后守望模式的建议就有了项目全局视野
- **压缩机制**：对话历史超过约 6 万字符时，自动把旧轮次蒸馏成 300 字内的摘要（保留近期 12 条原文），面板提示「🗜 对话已压缩」；同一次蒸馏顺带做**记忆沉淀**——值得长期记住的约定/决策/偏好按分区增量合并进 `.vs-agent/memory.md`（只追加不覆写，保住人类手动编辑）；完整记录仍可从日志 transcript 复盘。整理挂靠在「一章结束」的自然节点，不依赖 VS Code 关闭钩子（`deactivate` 不保证被调用、也没有时间发 LLM 请求，所有状态都是每步落盘的 crash-safe 设计）

## 调试与复盘（日志）

对齐业界做法（Claude Code 的 JSONL transcript、Cline 的任务历史），双通道记录一切行为：

- **实时日志**：VS Code Output 面板选「QuietPair」频道，带级别的流式日志
- **会话 transcript**：每次会话写一份 JSONL（`globalStorage/logs/session-*.jsonl`），按时间顺序记录完整事件流——比界面上看到的多得多

记录的事件类型：

| kind | 内容 |
| --- | --- |
| `user` / `assistant` | 用户消息、AI 完整回答（含被打断的半成品） |
| `tool_call` / `tool_result` | 工具名、参数、结果（截断保护） |
| `approval` | 审批请求内容 + 用户批准/拒绝的决定 |
| `companion` | 守望全链路：触发原因（`deletion`/`paste`/`statement-boundary`/`typing`）与延迟、语义闸门判定（`settled`/`retry`/`giveup`/`chat-busy`）、冷却闸门（`cooldown` + 等待时长）、哈希去重跳过、分析中自主取证的工具调用、分析结果（建议数、级别、明细） |
| `usage` | 每次 LLM 调用的 token 用量（来源 `chat`/`companion`/`compact`，输入/输出分开计） |
| `interrupt` | 打断时刻正在做什么、说到了哪 |
| `error` | API 错误等异常 |

查看入口：面板顶栏 **Logs** 或命令 `QuietPair: Open Logs`，可打开本次会话 transcript / 实时 Output 面板 / 日志目录。

**Token 用量统计**：请求时带 `stream_options.include_usage`，每次调用（聊天/守望/压缩，含守望自主取证的每一轮）的输入/输出 token 都累计——面板工具栏右侧的 `⇅ 12.3k` 小计数显示本次会话总量，悬停看分来源明细和历史累计（存 globalState 跨会话）；每次调用同时记一条 `usage` 事件进 transcript。注意：不返回 usage 的网关不计入统计。

## 如何运行调试

1. 用 VS Code 打开本文件夹：`code /Users/herta/learning/vs_agent`
2. 按 **F5** 启动「扩展开发宿主」窗口
3. 在新窗口左侧活动栏点 QuietPair 图标，打开 Chat 面板
4. 点Settings配 baseUrl 和 model，点「Key」填入 API key
5. 点Init让 AI 先探索一遍项目、建立初始记忆（可选但推荐，守望建议会因此更懂项目）
6. 随便打开一个代码文件编辑几行，停笔约 10 秒，守望模式会自动分析并推送建议；也可以直接在输入框提问

改代码后运行 `npm run watch` 自动编译，调试窗口按 `Cmd+R` 刷新。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run compile` | 编译 TypeScript 到 `out/` |
| `npm run watch` | 监听文件变化自动编译 |
| `npm test` | 跑单元测试（vitest，127 项：`tests/` 下，vscode API 由 `tests/vscode-stub.ts` 桩替代） |

CI：`.github/workflows/ci.yml` 在 push/PR 时跑 compile + test（需要把仓库推到 GitHub 才生效）。

## 参考文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：模块划分、数据流、设计决策
- [docs/USER_FLOW.md](docs/USER_FLOW.md)：用户流（mermaid 图）与用户故事
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)
