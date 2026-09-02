import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { api } from "./api";
import { endSession, signInEmail, signInGoogle, signUpEmail } from "./auth";
import { directChatJson } from "./openai";
import { __resetServerWriteOperationsForTests, awaitServerWriteOperationsQuiescent, runServerWriteOperation } from "./serverWriteOperations";
import { __resetSignOutBarrierForTests, activateSignOutAttempt, createSignOutPermit } from "./signOutBarrier";
import { pushLocalToServer, resetServerE2ee } from "./sync/transport";
import { upgradeServerE2eeV2 } from "./sync/upgrade";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  __resetSignOutBarrierForTests();
  __resetServerWriteOperationsForTests();
});

afterEach(() => {
  __resetSignOutBarrierForTests();
  __resetServerWriteOperationsForTests();
});

describe("server-write operation barrier", () => {
  it("waits for an already-started destructive write before quiescence", async () => {
    const flight = deferred();
    const operation = runServerWriteOperation("backup-replace", () => flight.promise);
    let quiescent = false;
    const waiting = awaitServerWriteOperationsQuiescent().then(() => {
      quiescent = true;
    });

    await Promise.resolve();
    expect(quiescent).toBe(false);
    flight.resolve();
    await Promise.all([operation, waiting]);
    expect(quiescent).toBe(true);
  });

  it("rejects a new write while blocked and permits only the sole coordinated attempt", async () => {
    activateSignOutAttempt("attempt-a", "source-a", "local");
    const permit = createSignOutPermit("attempt-a");

    await expect(runServerWriteOperation("e2ee-reset", async () => {})).rejects.toThrow("sign_out_in_progress");
    await expect(runServerWriteOperation("sync-final-flush", async () => {}, permit)).resolves.toBeUndefined();

    activateSignOutAttempt("attempt-b", "source-b", "remote");
    await expect(runServerWriteOperation("sync-final-flush", async () => {}, permit)).rejects.toThrow("sign_out_in_progress");
  });

  it("tracks a real in-flight direct E2EE write and blocks every destructive entry path", async () => {
    const response = deferred();
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      await response.promise;
      return new Response(JSON.stringify({ epoch: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const rekey = api.e2eeRekey({ wrappedDek: "wrapped", kdfParams: "params", userId: "user", expectedEpoch: 1 });
      await Promise.resolve();
      activateSignOutAttempt("attempt", "source", "remote");
      let quiescent = false;
      const waiting = awaitServerWriteOperationsQuiescent().then(() => {
        quiescent = true;
      });
      await Promise.resolve();
      expect(quiescent).toBe(false);

      response.resolve();
      await Promise.all([rekey, waiting]);
      expect(fetches).toBe(1);
      await expect(
        api.e2eeEnable({
          wrappedDek: "wrapped",
          kdfParams: "params",
          snapshotBlob: "ciphertext",
          userId: "user",
          budgetId: "budget",
          nextEpoch: 2,
          credentialAction: { kind: "none" },
        }),
      ).rejects.toThrow("sign_out_in_progress");
      await expect(
        api.e2eeDisable({
          confirm: "DISABLE-E2EE",
          ledger: { accounts: [], groups: [], envelopes: [], transactions: [], allocations: [], categories: [], places: [], budgets: [] },
          userId: "user",
          budgetId: "budget",
          expectedEpoch: 1,
          credentialAction: { kind: "none" },
        }),
      ).rejects.toThrow("sign_out_in_progress");
      await expect(pushLocalToServer()).rejects.toThrow("sign_out_in_progress");
      await expect(resetServerE2ee()).rejects.toThrow("sign_out_in_progress");
      await expect(upgradeServerE2eeV2(null)).rejects.toThrow("sign_out_in_progress");
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("blocks session-changing auth and OpenAI POST operations before transport starts", async () => {
    activateSignOutAttempt("attempt", "source", "remote");

    await expect(signInEmail("a@example.com", "password", false)).rejects.toThrow("sign_out_in_progress");
    await expect(signUpEmail("a@example.com", "password", false)).rejects.toThrow("sign_out_in_progress");
    await expect(signInGoogle()).rejects.toThrow("sign_out_in_progress");
    await expect(endSession()).rejects.toThrow("sign_out_in_progress");
    await expect(directChatJson({ messages: [{ role: "user", content: "hello" }] }, "secret", "gpt-5.6-luna")).rejects.toThrow("sign_out_in_progress");
  });

  it("keeps every direct server-write module enrolled in the shared operation registry", async () => {
    const root = new URL(".", import.meta.url).pathname;
    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root, onlyFiles: true })) {
      if (file.endsWith(".test.ts")) continue;
      const source = await Bun.file(`${root}/${file}`).text();
      const directWrite =
        (source.includes("fetch(") && /["'](?:POST|PUT|PATCH|DELETE)["']/.test(source)) || /authClient\.(?:signIn|signUp|signOut)/.test(source);
      if (directWrite) files.push(file);
    }
    files.sort();
    expect(files).toEqual(["accountPreferencesRemote.ts", "api.ts", "auth.ts", "e2ee.ts", "openai.ts", "sync/transport.ts", "sync/upgrade.ts"]);
    const missing: string[] = [];
    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      if (!source.includes("runServerWriteOperation")) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});
