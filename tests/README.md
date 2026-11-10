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
