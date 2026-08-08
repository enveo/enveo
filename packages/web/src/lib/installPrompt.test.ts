import { describe, expect, it } from "bun:test";
import { installState, runPrompt } from "./installPrompt";

const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/126 Mobile/15E148 Safari/604.1";
const IOS_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS]";
const DESKTOP_FF = "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0";

describe("installState", () => {
  it("standalone display wins over everything → installed", () => {
    expect(installState({}, ANDROID, true)).toBe("installed");
    expect(installState(null, IOS_SAFARI, true)).toBe("installed");
  });

  it("a held beforeinstallprompt event → promptable (Android and desktop Chromium)", () => {
    expect(installState({}, ANDROID, false)).toBe("promptable");
    expect(installState({}, DESKTOP_CHROME, false)).toBe("promptable");
  });

  it("iOS Safari with no event → ios-safari", () => {
    expect(installState(null, IOS_SAFARI, false)).toBe("ios-safari");
  });

  it("iOS Chrome / in-app webview → ios-other", () => {
    expect(installState(null, IOS_CHROME, false)).toBe("ios-other");
    expect(installState(null, IOS_INAPP, false)).toBe("ios-other");
  });

  it("desktop Firefox with no event → unavailable", () => {
    expect(installState(null, DESKTOP_FF, false)).toBe("unavailable");
  });
});

describe("runPrompt", () => {
  it("resolves to the native userChoice outcome", async () => {
    let prompted = false;
    const e = {
      prompt: async () => { prompted = true; },
      userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
    };
    const outcome = await runPrompt(e as never);
    expect(prompted).toBe(true);
    expect(outcome).toBe("accepted");
  });
});
