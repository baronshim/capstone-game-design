import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// The `test` environment carries no AI binding: that binding is remote-only and
// the pool cannot start with it present unless wrangler is logged in.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc', environment: 'test' } })],
});
