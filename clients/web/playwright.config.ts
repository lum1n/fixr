import { defineConfig, devices } from "@playwright/test";

// e2e against spec/echo-server: `pnpm build && pnpm e2e`. Ports are off the usual 8787
// so a running echo server for manual testing does not clash.
export const PORTS = { demo: 18903, echo: 18901, retry: 18902, down: 18999 };
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORTS.demo}`, ...devices["Desktop Chrome"] },
  webServer: [
    { command: `node demo/serve.mjs --port ${PORTS.demo}`, url: `http://localhost:${PORTS.demo}/demo/index.html`, reuseExistingServer: true },
    { command: `node ../../spec/echo-server/server.mjs --port ${PORTS.echo} --out out/e2e`, port: PORTS.echo, reuseExistingServer: false },
    { command: `node ../../spec/echo-server/server.mjs --port ${PORTS.retry} --fail-first 1 --out out/e2e-retry`, port: PORTS.retry, reuseExistingServer: false },
  ],
});
