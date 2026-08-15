import { describe, expect, it } from "bun:test";
import { startupPresentation } from "./startupSplash";
import type { BootStatus } from "./store";

describe("startup presentation", () => {
  it("keeps the themed application hidden while account preferences are booting", () => {
     
    const bootStatus: BootStatus = "booting";

     
    const presentation = startupPresentation(bootStatus);

     
    expect(presentation).toBe("splash");
  });

  it("hands control to every terminal boot screen instead of trapping the splash", () => {
     
    const terminalStatuses: BootStatus[] = ["ready", "error", "unauthed", "locked", "foreign"];

     
    for (const status of terminalStatuses) expect(startupPresentation(status)).toBe("app");
  });
});
