# 用户流（User Flows）

> 本文档描述 VS Agent **当前版本**的用户交互流，用 mermaid 表达。
> **维护约定**：每次改动交互行为后，必须同步更新本文档 + README.md + docs/ARCHITECTURE.md。

角色定义：

| 角色 | 是什么 |
| --- | --- |
| 用户 | 写代码的人，大部分时间只看编辑器，不看面板 |
| 守望（Observer） | companion 模块：被动观察、分级推送建议、复审 |
| 聊天 Agent | 对话与工具执行：讨论、改文件、跑命令 |
| 记忆 | 会话历史（workspaceState）+ 项目记忆（.vs-agent/memory.md）+ transcript |

设计总原则：**人的注意力是稀缺资源**。常态静默（L1、复审通过），弱打断走编辑器标注（L2），只有真正需要人判断时才上升到用户面前（L3 通知、复审两轮未过、审批请求）。聊天窗口是讨论的容器，不是发起交互的入口。

## 流 1：守望观察（AI 主动开口的主链路）

```mermaid
sequenceDiagram
    participant U as 用户
    participant O as 守望
    participant M as LLM
    participant E as 编辑器

    U->>E: 编写代码
    E->>O: 编辑事件（同时进本地活动缓冲区，零 token）
    O->>O: 编辑分类（删除/粘贴/语句边界 3s；普通打字 10s）
    O->>O: 语义闸门（括号配对 + 光标边界，重试 ≤3 次）
    O->>O: 哈希去重 → 冷却闸门（间隔 <300s 推迟）
    O->>M: 分析（注入项目记忆 + 最近 15 分钟活动轨迹；可自主调 read_file/list_files 取证 ≤3 轮）
    Note over U,M: 另一条路：用户主动保存 → 轻量分诊（YES/NO）→ 值得则绕过冷却叫醒分析
    M-->>O: 结构化建议（行号/级别/说明/修复参考）
    alt 有建议
        O->>E: L2/L3 波浪线 + CodeLens + 问题面板
        O->>U: 仅 L3：系统通知 + 面板自动展开
    else 没问题
        O->>O: 静默丢弃
    end
```

## 流 2：用户回应建议（核心交互闭环）

```mermaid
flowchart TD
    A[建议标注在编辑器里] --> B{用户看到后}
    B -->|理解了，自己改| C[手动修改代码]
    C --> D[标注变暗：待确认]
    D --> E[点Fixed]
    E --> F{文件有变化？}
    F -->|有| G[LLM 绕过冷却复审]
    G -->|修好了| H[标注消除，面板低调确认]
    G -->|问题还在| I[指出剩余问题，标注保留/更新]
    F -->|没有| J[不白调 LLM：现有标注就是最新判断<br>提示去点Fix for me或Discuss]
    B -->|懒得改| I[点Fix for me]
    I --> J[聊天 Agent 接手，流 3]
    B -->|不理解| K[点Discuss]
    K --> L[建议进入聊天引用 chip]
    L --> M[用户输入问题，正常聊天]
```

## 流 3：Agent 产出对账（内部闭环，原则上不打扰用户）

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as 聊天 Agent
    participant O as 守望

    A->>A: write_file（用户审批通过）
    A-->>O: 触发复审（绕过冷却，只报与本次改动相关的问题）
    alt 复审干净（仅 L1 或无问题）
        O->>O: 标注静默消除，只记 transcript
    else 发现 L2/L3
        O->>A: 回灌「守望复审反馈」（≤2 轮）
        A->>A: 自我修正（继续修 / 解释理由）
        A-->>O: 再次复审
    end
    alt 两轮仍未通过
        O->>U: 摊牌：「我们来回两遍了，你判断一下」
    end
```

## 流 4：聊天与打断

```mermaid
flowchart TD
    A[用户发消息] --> B[Agent 运行：流式输出 + 工具循环]
    B --> C{危险操作？}
    C -->|write_file / 非白名单 run_command| D[弹审批：允许 / 拒绝<br>permissionMode=discuss 时直接拒绝不弹窗<br>yolo 时自动通过并记日志]
    D --> B
    C -->|只读工具 / 白名单只读命令| B
    B --> E{用户此时发新消息？}
    E -->|是| F[立即打断：流/工具/待审批全部中止<br>半成品标记「用户打断了这里」留存]
    F --> G[处理新消息]
    E -->|否| H[正常完成]
```

## 流 5：记忆的生命周期

```mermaid
flowchart LR
    A[Init] -->|选项卡：Guide me through it / Summarize for me / I know it already| M{模式}
    M -->|帮我总结| S[Agent 探索项目] --> B[.vs-agent/memory.md]
    M -->|带我读一遍| G[阅读地图 → 逐站陪同 → 理解确认] --> B
    C[日常对话] -->|update_memory 工具| B
    D[对话压缩 6 万字符] -->|蒸馏 durable 条目| B
    B -->|注入 prompt| E[聊天 Agent]
    B -->|注入 prompt| F[守望分析]
    C -->|每轮落盘| G2[workspaceState 会话历史]
    H[一切行为] -->|实时追加| I[transcript JSONL]
```

## 用户故事（User Stories）

按优先级排列，每条标注实现状态：

- ✅ 作为写代码的人，我希望 AI 在我停笔时主动给出建议，而不是我去问它
- ✅ 作为用户，我希望建议按严重程度分级呈现，小事不打扰、大事必打断
- ✅ 作为用户，我希望看到建议后一键「改好了 / 帮我改 / 讨论」，不用打字描述是哪条
- ✅ 作为用户，我希望 AI 改完的代码有另一个「眼睛」复审，通过后安静消失，不通过时它们自己先扯清楚，扯不清再找我
- ✅ 作为用户，我希望随时能打断 AI 的发言和动作，像跟真人说话一样
- ✅ 作为用户，我希望 AI 记得这个项目的约定和我们做过的决定，重开 VS Code 也不用重讲
- ✅ 作为用户，我希望第一次使用时 AI 能自己先熟悉项目（Init）
- ✅ 作为刚接手项目的人，我希望 AI 带我读一遍代码——给阅读地图、逐站陪同、验证我的理解，而不是替我读（Init选"Guide me through it"）
- ✅ 作为用户，我希望 AI 拿不准时能自己去读项目里的文件，而不是瞎猜
- ✅ 作为用户，我希望所有 AI 行为都能复盘（transcript），token 花了多少心里有数
- 🟡 作为用户，我希望 AI 理解我「这段时间在干什么」（工作焦点/意图跟踪），基于行为模式搭话——**一期已实现**（本地活动轨迹注入分析，跨文件视野）；**二期分诊已实现**（保存时轻量模型决定是否叫醒深度层）；「速记员」滚动总结工作焦点待做
- 🔲 作为用户，我希望可以告诉 AI「别再提这类建议」，它记住并遵守——**禁区分区已有，一键忽略未实现**
