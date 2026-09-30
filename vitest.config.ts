import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
  },
  resolve: {
    alias: {
      '@colosseum/schemas': path.resolve(import.meta.dirname, 'packages/schemas/src/index.ts'),
      '@colosseum/db': path.resolve(import.meta.dirname, 'packages/db/src/index.ts'),
      '@colosseum/engine': path.resolve(import.meta.dirname, 'packages/engine/src/index.ts'),
      '@colosseum/chain-solana': path.resolve(
        import.meta.dirname,
        'packages/chain-solana/src/index.ts',
      ),
      '@colosseum/chain-evm': path.resolve(import.meta.dirname, 'packages/chain-evm/src/index.ts'),
    },
  },
});
