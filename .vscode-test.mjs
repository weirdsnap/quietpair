import { defineConfig } from '@vscode/test-cli';

// 真实宿主冒烟测试配置：下载一份干净 VS Code（缓存在 .vscode-test/），
// 以本仓库为开发中扩展启动，跑 smoke/ 下的 mocha 测试
export default defineConfig({
  files: 'smoke/*.test.js',
  launchArgs: ['--disable-extensions'], // 只加载被测扩展，排除用户已装扩展的干扰
});
