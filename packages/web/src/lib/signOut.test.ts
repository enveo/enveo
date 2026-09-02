import { afterEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { __resetStorageForTests, clearLocalData, idbGetAll, idbPut } from "./idb";
import { completeExplicitSignOut, ExplicitSignOutPendingError, prepareExplicitSignOut, type SignOutDeps } from "./signOut";
import type { CoordinatedSignOutLease } from "./sync";

const lease = Object.freeze({}) as CoordinatedSignOutLease;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  __resetStorageForTests();
});

function fixture(overrides: Partial<SignOutDeps> = {}) {
  const calls: string[] = [];
  const deps: SignOutDeps = {
    beginCoordination: async () => {
      calls.push("begin");
      return lease;
    },
    cancelCoordination: () => calls.push("cancel"),
    flushPending: async () => {
      calls.push("flush");
      return 0;
    },
    canExport: () => true,
    exportBackup: () => calls.push("export"),
    canRequestClearSiteData: async () => {
      calls.push("canRequestClearSiteData");
      return true;
    },
    endSession: async (_lease, clearSiteData) => {
      calls.push(`endSession(clearSiteData=${clearSiteData})`);
    },
    markServerSucceeded: () => calls.push("serverSucceeded"),
    clearLocalAccountData: async () => {
      calls.push("clearCredentialMaterial");
      calls.push("clearLastAccount");
      calls.push("clearLocalAccountData(caches,replica,outbox,owner,dek)");
    },
    finishCoordination: () => calls.push("finish"),
    reloadOrLogin: () => calls.push("reloadOrLogin"),
    ...overrides,
  };
  return { deps, calls };
}

describe("explicit sign-out", () => {
  it("flushes before ending the session, then clears all local account state before reloading", async () => {
    const f = fixture();

    await completeExplicitSignOut("retry", f.deps);

    expect(f.calls).toEqual([
      "begin",
      "flush",
      "canRequestClearSiteData",
      "endSession(clearSiteData=true)",
      "serverSucceeded",
      "clearCredentialMaterial",
      "clearLastAccount",
      "clearLocalAccountData(caches,replica,outbox,owner,dek)",
      "finish",
      "reloadOrLogin",
    ]);
  });

  it("stops before session termination and clearing when pending operations remain", async () => {
    const f = fixture({ flushPending: async () => 3 });

    await expect(completeExplicitSignOut("retry", f.deps)).rejects.toEqual(new ExplicitSignOutPendingError({ kind: "pending", count: 3 }));
    expect(f.calls).toEqual(["begin", "cancel"]);
  });

  it("reports when pending changes cannot be exported", async () => {
    const f = fixture({ flushPending: async () => 2, canExport: () => false });

    expect(await prepareExplicitSignOut(f.deps)).toEqual({ kind: "unexportable", count: 2 });
  });

  it("retry proceeds only after a later flush drains the queue", async () => {
    let attempt = 0;
    const f = fixture({
      flushPending: async () => {
        f.calls.push("flush");
        attempt++;
        return attempt === 1 ? 1 : 0;
      },
    });

    await expect(completeExplicitSignOut("retry", f.deps)).rejects.toBeInstanceOf(ExplicitSignOutPendingError);
    await completeExplicitSignOut("retry", f.deps);

    expect(f.calls).toEqual([
      "begin",
      "flush",
      "cancel",
      "begin",
      "flush",
      "canRequestClearSiteData",
      "endSession(clearSiteData=true)",
      "serverSucceeded",
      "clearCredentialMaterial",
      "clearLastAccount",
      "clearLocalAccountData(caches,replica,outbox,owner,dek)",
      "finish",
      "reloadOrLogin",
    ]);
  });

  it("exports a complete local backup before explicitly discarding pending changes", async () => {
    const f = fixture();

    await completeExplicitSignOut("export", f.deps);

    expect(f.calls[0]).toBe("export");
    expect(f.calls[1]).toBe("begin");
    expect(f.calls.at(-1)).toBe("reloadOrLogin");
  });

  it("keeps the session and local data when backup export fails", async () => {
    const f = fixture({
      exportBackup: () => {
        f.calls.push("export:failed");
        throw new Error("export_failed");
      },
    });

    await expect(completeExplicitSignOut("export", f.deps)).rejects.toThrow("export_failed");
    expect(f.calls).toEqual(["export:failed"]);
  });

  it("allows an explicit destructive discard without exporting", async () => {
    const f = fixture();

    await completeExplicitSignOut("discard", f.deps);

    expect(f.calls).toContain("flush");
    expect(f.calls).not.toContain("export");
    expect(f.calls).toContain("clearLocalAccountData(caches,replica,outbox,owner,dek)");
  });

  it("does not request browser-wide cleanup for a memory session or an unverified owner", async () => {
    const f = fixture({
      canRequestClearSiteData: async () => {
        f.calls.push("canRequestClearSiteData:false");
        return false;
      },
    });

    await completeExplicitSignOut("discard", f.deps);

    expect(f.calls).toContain("endSession(clearSiteData=false)");
  });

  it("does not clear anything when ending the server session fails", async () => {
    const f = fixture({
      endSession: async () => {
        f.calls.push("endSession:failed");
        throw new Error("server_sign_out_failed");
      },
    });

    await expect(completeExplicitSignOut("discard", f.deps)).rejects.toThrow("server_sign_out_failed");
    expect(f.calls).toEqual(["begin", "flush", "canRequestClearSiteData", "endSession:failed", "cancel"]);
  });

  it("does not reload when clearing local account data fails", async () => {
    const f = fixture({
      clearLocalAccountData: async () => {
        f.calls.push("clearLocalAccountData:failed");
        throw new Error("clear_failed");
      },
    });

    await expect(completeExplicitSignOut("discard", f.deps)).rejects.toThrow("local_sign_out_cleanup_failed");
    expect(f.calls).not.toContain("reloadOrLogin");
  });

  it("removes durable import jobs and unacknowledged drafts with the signed-out account", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
    __resetStorageForTests();
    await idbPut("importJobs", { id: "11111111-1111-1111-1111-111111111111", ciphertext: "v2.job" });
    await idbPut("importDrafts", { id: "22222222-2222-2222-2222-222222222222", requestHash: "draft" });
    const f = fixture({ clearLocalAccountData: clearLocalData });

    await completeExplicitSignOut("discard", f.deps);

    expect(await idbGetAll("importJobs")).toEqual([]);
    expect(await idbGetAll("importDrafts")).toEqual([]);
  });
});
