import { describe, expect, it } from "bun:test";
import { startupPresentation } from "./startupSplash";
import type { BootStatus } from "./store";

describe("startup presentation", () => {
  it("keeps the themed application hidden while account preferences are booting", () => {
    // given: the replica and its account-scoped theme are still being hydrated
    const bootStatus: BootStatus = "booting";

    // when: the first screen is selected
    const presentation = startupPresentation(bootStatus);

    // then: only the theme-independent brand splash may be painted
    expect(presentation).toBe("splash");
  });

  it("hands control to every terminal boot screen instead of trapping the splash", () => {
    // given: boot has reached a state with a real screen or a recovery action
    const terminalStatuses: BootStatus[] = ["ready", "error", "unauthed", "locked", "foreign"];

    // when / then: each status leaves the startup splash
    for (const status of terminalStatuses) expect(startupPresentation(status)).toBe("app");
  });
});
