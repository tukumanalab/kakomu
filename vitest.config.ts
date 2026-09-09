import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// 単体テストは DOM を使わない純粋なロジックだけを対象にする
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
