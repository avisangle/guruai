import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Bindings (UPLOADS, RATE_LIMITER, vars) come from wrangler.toml; test secrets
// override them so presigned URLs are deterministic and nothing leaves the machine.
export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          APP_KEY: "test-app-key",
          R2_ACCESS_KEY_ID: "test-access-key-id",
          R2_SECRET_ACCESS_KEY: "test-secret-access-key",
          ACCOUNT_ID: "testaccount",
          BUCKET: "guru-uploads-test",
        },
      },
    }),
  ],
});
