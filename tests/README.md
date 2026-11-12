# 测试层次

QuietPair 的测试分四层，自下而上成本递增、保真度递增。**默认把新逻辑放在能被 L0 测到的位置**——如果一段逻辑测不了 L0，那是该抽纯函数/纯模块的信号（本项目的既定模式：decision / confirmGate / editTracker / importGraph / mdrender / replay 都是这么来的）。

```
tests/
├── unit/            L0 纯逻辑单元测试（最快，毫秒级）
├── stubbed/         L1 vscode 桩集成测试
├── contract/        L2 静态契约门禁（不执行产品代码，扫源码）
├── vscode-stub.ts   L1 共享的最小 vscode 桩（vitest alias 注入）
└── README.md        本文件
smoke/
└── extension.test.js  L3 真实宿主冒烟（下载干净 VS Code 真实激活扩展）
```

## L0 纯逻辑单元（`tests/unit/`，`npm run test:unit`）

被测模块不 import `vscode`（type-only 不算——编译期擦除，测试里用鸭子类型 fake 即可）。
跑在任何环境，无需桩。

现有：lineDiff / editTracker / importGraph / confirmGate / decision / gate（vscode 仅类型）/
detect / sharedContext / telemetry / prompts / llm / replay / mdrender（media 的 UMD 模块）。

规则：
- 新纯逻辑模块 → 测试放这里；
- 断言行为契约，不钉实现细节；
- 边界就是文档：闸门判定矩阵、diff 数学、解析器的合法/非法形态。

## L1 vscode 桩集成（`tests/stubbed/`，`npm run test:stubbed`）

被测模块必须在 vscode API 上运行（文件系统在工作区内、Output 通道等），
由 `vitest.config.ts` 把 `import 'vscode'` alias 到 `vscode-stub.ts` 的最小实现。

现有：tools（白名单/路径守卫/审批语义）、logger（JSONL 落盘 + ring buffer）。

规则：
- 桩保持最小：只加被测模块真实用到的 API（`setWorkspaceRoot` / `setConfig` 这类测试控制口可以开）；
- 桩给不了的行为（事件流、真实编辑器、webview）不属于这一层——要么抽纯逻辑下移到 L0，要么靠 L3/人工。

## L2 静态契约门禁（`tests/contract/`，`npm run test:contract`）

不执行产品代码，扫源码文本验证隐性合约闭合。

现有：webview-contract——chat.js 引用的 DOM id 必须存在于 chatView.ts 生成的 HTML；
双向消息 type 必须各有 case。抓的是「拼写漂移」（webview 脚本报错 = 整面板死亡）。

规则：任何「两边各写一份、运行时才对得上」的接口都值得一张契约门禁。

## L3 真实宿主冒烟（`smoke/`，`npm run test:smoke`）

`@vscode/test-cli` 下载干净 VS Code 真实加载扩展：activate 全路径、package.json 声明命令全部注册、
webview 视图挂载。L0–L2 全走桩，证明不了「F5 即崩」这一类问题。

规则：
- 慢且重，只守激活级保证，不在这里测业务行为；
- 交互式命令（modal 确认）在测试里用 monkey-patch 自动应答，不改产品代码迁就无头宿主。

## 运行方式

| 命令 | 范围 |
| --- | --- |
| `npm test` | L0+L1+L2 全部（CI build-test job） |
| `npm run test:unit` / `test:stubbed` / `test:contract` | 单层 |
| `npm run test:smoke` | L3（CI smoke job，需下载 VS Code；Linux 需 xvfb） |

## 测试设计方法学

分层解决「在哪测」；方法学解决「测什么」。本项目使用的技术与适用场景：

**判定表（Decision Table）** —— 多条件组合决定少数动作的逻辑（闸门/分诊/优先级链）。
把条件桩 × 动作写成显式表格驱动测试：每条规则至少一个具体化行，「不可能组合」用防御行钉死，
**未覆盖的组合格就是测试洞**（confirmGate 的「无关文件动过不挡 untouched」就是这么补上的）。
范例：`tests/unit/confirmGate.test.ts`、`tests/unit/detect.test.ts`（优先级冲突）。

**边界值分析（BVA）** —— 带数值边界/阈值的逻辑。
选点：边界值本身、边界 ±1、退化输入（空、单元素、零参数）。
「恰好 1000 不裁、1001 才裁」「margin=0 时 prefixLines 本身仍算未变」都是 BVA 选点。
经验：边界测试红了先怀疑测试数据的边界语义（editTracker 的 ts=0 撞上严格大于就是测试自己的边界搞错了）。

**等价类划分（Equivalence Partitioning）** —— 输入形态可分类的解析/匹配逻辑。
每个类一个代表即可；异常形态类必须显式列出（自引用、循环引用、解析失败、上窜钳制），
它们是最容易被实现漏掉的类。范例：`tests/unit/importGraph.test.ts`。

**属性测试（Property-Based Testing，fast-check）** —— 输入空间巨大的纯函数（解析器、diff、转义）。
不钉例子，钉**不变量**：每条属性必须对应产品逻辑真实依赖的保证
（如「findQuote 报找到 ⇒ 报告行起的内容与 quote 逐行一致」就是内容锚确认的物理基础）。
生成器要引导撞出有趣结构（小字母表提高行撞车率、显式注入 ```），纯随机输入测不到深处。
范例：`tests/unit/property.test.ts`。

**错误推测 / 变异思维（Error Guessing & Mutation thinking）** —— 无工具，是惯例：
每个修过的 bug 先补一条「没修时会红」的测试（importGraph 的 removeFile 入边、python `from . import x` 上窜、
未闭合围栏首换行，都是这么进测试的）；改判定逻辑时自问「哪条旧测试应该变红」，没有就是覆盖洞。

选型直觉：条件组合多 → 判定表；有阈值/边界 → BVA；输入形态可枚举 → 等价类；
输入空间爆炸的纯函数 → 属性测试；修 bug → 永远先补回归测试。
