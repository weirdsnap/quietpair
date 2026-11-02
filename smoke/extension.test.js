/**
 * 真实扩展宿主冒烟测试（@vscode/test-electron，跑在真 VS Code 进程里）。
 *
 * 为什么需要它：vitest 套件全部走 tests/vscode-stub.ts 桩，证明不了扩展在真实
 * 宿主里能活——activate() 抛异常、package.json 贡献点写错这类「F5 即崩」的问题，
 * 只有真实宿主能暴露。这个文件就是那道门禁。
 *
 * 运行：npm run test:smoke（首次会下载一份 VS Code 到 .vscode-test/）
 */
const assert = require('assert');
const vscode = require('vscode');

const pkg = require('../package.json');
const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

suite('QuietPair smoke（真实宿主）', () => {
  test('扩展存在于宿主并能激活（activate() 全路径不抛异常）', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found in host`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension failed to activate');
  });

  test('package.json 声明的每个命令都已注册', async () => {
    const declared = pkg.contributes.commands.map((c) => c.command);
    assert.ok(declared.length > 0, 'no commands declared');
    const registered = await vscode.commands.getCommands(true);
    for (const cmd of declared) {
      assert.ok(registered.includes(cmd), `command declared but not registered: ${cmd}`);
    }
  });

  test('声明的 webview 视图已挂到视图容器', async () => {
    // 视图贡献点没有直接 API 可查，但 VS Code 会为每个视图生成 <viewId>.focus 命令
    const registered = await vscode.commands.getCommands(true);
    for (const container of Object.values(pkg.contributes.views)) {
      for (const view of container) {
        assert.ok(
          registered.includes(`${view.id}.focus`),
          `view ${view.id} not contributed (no ${view.id}.focus command)`,
        );
      }
    }
  });

  test('无 UI 命令可执行（clearChat / analyzeNow 走通命令→模块链路）', async () => {
    // clearChat：重置会话历史（无面板时 post 为 no-op）
    await assert.doesNotReject(() => vscode.commands.executeCommand('vs-agent.clearChat'));
    // analyzeNow：无活动编辑器 → 走 notice 分支，不发网络请求
    await assert.doesNotReject(() => vscode.commands.executeCommand('vs-agent.analyzeNow'));
  });
});
