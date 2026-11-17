import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { normaliseBasePath } from './src/app/basePath';

export default defineConfig({
  base: normaliseBasePath(process.env.BASE_PATH ?? '/'),
  plugins: [react()],
  worker: { format: 'es' },
  test: { fileParallelism: false, testTimeout: 30_000 },
});
