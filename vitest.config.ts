/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    // oruDir 必须排最先：ORU_DIR 兜底注入要抢在任何业务模块（paths.ts）求值之前
    // i18n：渲染真组件的测试里 useTranslation 回落到此实例，t() 返回真实中文
    setupFiles: ['tests/setup/oruDir.ts', 'tests/setup/i18n.ts'],
    // 路由/runner 类测试的首个用例在测试体内动态 import 整张主进程模块图（ORU_DIR 范式所需），
    // transform 压着默认 5s 线、并行负载下整批误杀（长期 flake 源）。真挂死 20s 照样红。
    testTimeout: 20_000,
  },
});
