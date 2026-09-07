/**
 * Browser smoke test against the BUILT web app served by the real API (`bun run e2e`).
 *
 * One script, one flow, no framework: it exists because three layout/boot regressions in a
 * row passed `bun test` + `tsc` and failed on a phone. Unit tests cannot see a blank `#root`,
 * a service worker that never registers, or a replica that does not survive a reload.
 *
 * What it proves, end to end, in headless Chromium:
 *   1. the production bundle boots to the Login screen (CSP, SW, lazy chunks),
 *   2. the first account can be created (auth + signup gate),
 *   3. onboarding's sample data reaches the dashboard,
 *   4. a transaction added in the UI is visible after a full reload (write → outbox → sync →
 *      replica boot), and the account balance moved by exactly that amount.
 *
 * Environment: the same proof of intent as `test:db` (scripts/lib/testEnv.ts) — a THROWAWAY
 * `TEST_DATABASE_URL` plus `ENVEO_TEST_DB_ACK=throwaway`. The script creates and drops its own
 * `<database>_e2e` next to it, migrates, starts the API on a free port with
 * `WEB_DIST=packages/web/dist` (run `bun run build:web` first) and tears everything down.
 * Browser: `bunx playwright install chromium` once per machine; CI does it in verify.yml.
 *
 * Set E2E_DEBUG=1 to keep screenshots of every step under /tmp/enveo-e2e/.
 */
import { mkdirSync } from "node:fs";
import { SQL } from "bun";
import { chromium, type Page } from "playwright";
import { planTestEnv } from "./lib/testEnv";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB_DIST = `${ROOT}packages/web/dist`;
const DEBUG = process.env.E2E_DEBUG === "1";
const SHOTS = "/tmp/enveo-e2e";

const plan = planTestEnv("db", process.env);
if (!plan.ok) {
  console.error("e2e: refusing to start:\n  " + plan.errors.join("\n  "));
  process.exit(2);
}
const adminUrl = new URL(process.env.TEST_DATABASE_URL as string);
const e2eDb = `${adminUrl.pathname.slice(1)}_e2e`;
const e2eUrl = new URL(adminUrl);
e2eUrl.pathname = `/${e2eDb}`;

if (!(await Bun.file(`${WEB_DIST}/index.html`).exists())) {
  console.error(`e2e: ${WEB_DIST}/index.html is missing — run \`bun run build:web\` first.`);
  process.exit(2);
}

const admin = new SQL(adminUrl.href);
await admin.unsafe(`DROP DATABASE IF EXISTS "${e2eDb}"`);
await admin.unsafe(`CREATE DATABASE "${e2eDb}"`);

const childEnv = {
  ...process.env,
  DATABASE_URL: e2eUrl.href,
  TEST_DATABASE_URL: "",
  OPENAI_API_KEY: "",
  AI_SAFETY_IDENTIFIER_SECRET: "",
  BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  DEPLOYMENT: "selfhost",
  WEB_DIST,
  NODE_ENV: "production",
};

const migrate = Bun.spawnSync(["bun", "src/db/migrate.ts"], { cwd: `${ROOT}packages/api`, env: childEnv, stdout: "inherit", stderr: "inherit" });
if (migrate.exitCode !== 0) throw new Error(`e2e: migration failed (exit ${migrate.exitCode})`);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const api = Bun.spawn(["bun", "src/index.ts"], { cwd: `${ROOT}packages/api`, env: { ...childEnv, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
const apiOut = new Response(api.stdout).text();
const apiErr = new Response(api.stderr).text();

let failed: unknown = null;
try {
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20_000, "API health");
  await runFlow(base);
  const ledger = new SQL(e2eUrl.href);
  const rows = await ledger.unsafe("SELECT count(*)::int AS n FROM transactions WHERE amount = 4250 AND type = 'expense'");
  await ledger.close();
  if (rows[0]?.n !== 1) throw new Error(`expected exactly one 42.50 expense on the server, found ${rows[0]?.n}`);
  console.log("e2e: OK");
} catch (error) {
  failed = error;
} finally {
  api.kill("SIGTERM");
  await api.exited;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${e2eDb}"`);
  await admin.close();
}
if (failed) {
  console.error("e2e: FAILED —", failed instanceof Error ? failed.message : failed);
  console.error("--- API output ---\n" + (await apiOut) + (await apiErr));
  process.exit(1);
}

async function runFlow(base: string): Promise<void> {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (DEBUG) mkdirSync(SHOTS, { recursive: true });
  let step = 0;
  const shot = async (name: string) => {
    if (DEBUG) await page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, "0")}-${name}.png` });
  };
  try {
    // 1. Boot → Login (first run).
    await page.goto(base);
    await page.getByText("Create the owner account").waitFor({ timeout: 15_000 });
    await shot("login");

    // 2. First account.
    await page.getByPlaceholder("Email").fill("owner@example.com");
    await page.getByPlaceholder("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create account" }).click();

    // 3. Onboarding → sample data → dashboard.
    await page.getByRole("button", { name: "Try it with sample data" }).click();
    await page.getByText("$8,000.00").first().waitFor({ timeout: 30_000 });
    await shot("dashboard");

    // 4. Expense of 42.50 from the default account (Savings, $8,000.00 in the sample data).
    await page.getByRole("button", { name: "Expense" }).first().click();
    await page.getByText("FROM ACCOUNT").waitFor();
    for (const key of ["4", "2", ".", "5", "0"]) await page.getByRole("button", { name: key, exact: true }).click();
    await page.getByRole("button", { name: "✓", exact: true }).click();
    await shot("amount");
    await page.getByRole("button", { name: "Add expense" }).click();
    await page.getByText("$7,957.50").first().waitFor({ timeout: 15_000 });
    await shot("after-add");

    // 5. Full reload: the balance must come back from the local replica, without errors.
    await page.reload();
    await page.getByText("$7,957.50").first().waitFor({ timeout: 30_000 });
    await shot("after-reload");

    // 6. The write reached the server (sync push): a fresh browser signs in and sees it.
    const fresh = await context.browser()!.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    const page2 = await fresh.newPage();
    page2.on("pageerror", (e) => pageErrors.push(String(e)));
    await page2.goto(base);
    await page2.getByPlaceholder("Email").fill("owner@example.com");
    await page2.getByPlaceholder("Password").fill("correct-horse-battery");
    await page2.getByRole("button", { name: "Sign in", exact: true }).click();
    await page2.getByText("$7,957.50").first().waitFor({ timeout: 30_000 });
    if (DEBUG) await page2.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, "0")}-second-device.png` });
    await fresh.close();

    if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  } catch (error) {
    console.error("--- page text at failure ---\n" + (await bodyText(page)).slice(0, 2000));
    throw error;
  } finally {
    await shot("final");
    await browser.close();
  }
}

async function bodyText(page: Page): Promise<string> {
  return (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, "\n");
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`e2e: timed out waiting for ${what}`);
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  server.stop(true);
  return port;
}
