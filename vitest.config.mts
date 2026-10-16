import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // src 里的 import 'vscode' 在测试时指向最小桩
      vscode: path.resolve(__dirname, 'tests/vscode-stub.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
