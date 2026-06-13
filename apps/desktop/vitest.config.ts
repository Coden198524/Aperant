import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    exclude: ['node_modules', 'dist', 'out'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/**/*.d.ts'],
      thresholds: {
        lines: 22,
        branches: 17,
        functions: 19,
        statements: 22
      }
    },
    // Mock Electron modules for unit tests
    alias: {
      electron: resolve(__dirname, 'src/__mocks__/electron.ts')
    },
    // Setup files for test environment
    setupFiles: ['src/__tests__/setup.ts']
  },
  resolve: {
    alias: [
      { find: /^@autocode\/core$/, replacement: resolve(__dirname, '../../libs/core/src/index.ts') },
      { find: /^@autocode\/core\/(.+)$/, replacement: `${resolve(__dirname, '../../libs/core/src')}/$1` },
      { find: '@', replacement: resolve(__dirname, 'src') },
      { find: '@main', replacement: resolve(__dirname, 'src/main') },
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
    ]
  }
});
