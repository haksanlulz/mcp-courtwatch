import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // The offline suite stubs fetch, so every test was sleeping through the
      // real 200ms outbound throttle for nothing: 54 fully-mocked tests took
      // 16.3s, almost all of it waiting. 0 is a legitimate value of this
      // setting, not a fallback (see envInt in server.ts).
      //
      // test/throttle.test.ts sets its own gap and re-imports server.ts, so the
      // throttle itself is still measured — at a fake clock, not this one.
      COURTWATCH_THROTTLE_MS: "0",
    },
  },
});
