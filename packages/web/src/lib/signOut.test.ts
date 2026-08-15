import { describe, expect, it } from "bun:test";
import { completeExplicitSignOut, ExplicitSignOutPendingError, prepareExplicitSignOut, type SignOutDeps } from "./signOut";

function fixture(overrides: Partial<SignOutDeps> = {}) {
  const calls: string[] = [];
  const deps: SignOutDeps = {
    flushPending: async () => {
      calls.push("flush");
      return 0;
    },
    canExport: () => true,
    exportBackup: () => calls.push("export"),
    endSession: async () => {
      calls.push("endSession");
    },
    clearCredentialMaterial: () => calls.push("clearCredentialMaterial"),
    clearLastAccount: () => calls.push("clearLastAccount"),
    clearLocalAccountData: async () => {
      calls.push("clearLocalAccountData(caches,replica,outbox,owner,dek)");
    },
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
      "flush",
      "endSession",
      "clearCredentialMaterial",
      "clearLastAccount",
      "clearLocalAccountData(caches,replica,outbox,owner,dek)",
      "reloadOrLogin",
    ]);
  });

  it("stops before session termination and clearing when pending operations remain", async () => {
    const f = fixture({ flushPending: async () => 3 });

    await expect(completeExplicitSignOut("retry", f.deps)).rejects.toEqual(new ExplicitSignOutPendingError({ kind: "pending", count: 3 }));
    expect(f.calls).toEqual([]);
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
      "flush",
      "flush",
      "endSession",
      "clearCredentialMaterial",
      "clearLastAccount",
      "clearLocalAccountData(caches,replica,outbox,owner,dek)",
      "reloadOrLogin",
    ]);
  });

  it("exports a complete local backup before explicitly discarding pending changes", async () => {
    const f = fixture();

    await completeExplicitSignOut("export", f.deps);

    expect(f.calls[0]).toBe("export");
    expect(f.calls[1]).toBe("endSession");
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

    expect(f.calls).not.toContain("flush");
    expect(f.calls).not.toContain("export");
    expect(f.calls).toContain("clearLocalAccountData(caches,replica,outbox,owner,dek)");
  });

  it("does not clear anything when ending the server session fails", async () => {
    const f = fixture({
      endSession: async () => {
        f.calls.push("endSession:failed");
        throw new Error("sign_out_failed");
      },
    });

    await expect(completeExplicitSignOut("discard", f.deps)).rejects.toThrow("sign_out_failed");
    expect(f.calls).toEqual(["endSession:failed"]);
  });

  it("does not reload when clearing local account data fails", async () => {
    const f = fixture({
      clearLocalAccountData: async () => {
        f.calls.push("clearLocalAccountData:failed");
        throw new Error("clear_failed");
      },
    });

    await expect(completeExplicitSignOut("discard", f.deps)).rejects.toThrow("clear_failed");
    expect(f.calls).not.toContain("reloadOrLogin");
  });
});
