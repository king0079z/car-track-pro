import { defineConfig, devices } from '@playwright/test'

const backend = {
  command: 'python -m uvicorn app.main:app --host 127.0.0.1 --port 8001',
  cwd: '../backend',
  url: 'http://127.0.0.1:8001/api/health',
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    ...process.env,
    DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'sqlite:///./cartrack_e2e.db',
    SECRET_KEY: process.env.SECRET_KEY ?? 'e2e-test-secret-key-min-32-characters-long',
    ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    AUDIT_RUN_ON_STARTUP: 'false',
    AUDIT_STARTUP_DELAY_SECONDS: '99999',
    AUDIT_PERIODIC_INTERVAL_SECONDS: '99999',
  },
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    backend,
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
