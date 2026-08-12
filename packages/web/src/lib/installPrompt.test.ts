import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getInstallState, initInstallPrompt, installState, isInstallable, promptInstall, runPrompt, type InstallState } from "./installPrompt";

const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/126 Mobile/15E148 Safari/604.1";
const IOS_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS]";
// In-app browsers that KEEP the `Safari` token (real UA shapes: DuckDuckGo appends
// `Ddg/<version>`, the Google app appends `GSA/<version>`) — no Share → A2HS flow.
const IOS_DDG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 Ddg/17.0";
const IOS_GSA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/280.0.560472678 Mobile/15E148 Safari/604.1";
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

  it("iOS in-app browsers keeping the Safari token (DuckDuckGo Ddg/, Google app GSA/) → ios-other, not ios-safari", () => {
    expect(installState(null, IOS_DDG, false)).toBe("ios-other");
    expect(installState(null, IOS_GSA, false)).toBe("ios-other");
  });

  it("desktop Firefox with no event → unavailable", () => {
    expect(installState(null, DESKTOP_FF, false)).toBe("unavailable");
  });
});

/**
 * The ONE installability predicate — every UI site (banner, Drawer row, Settings card,
 * onboarding finish, InstallBody's null-return) must go through it instead of re-spelling
 * the two-state comparison in either polarity.
 */
describe("isInstallable", () => {
  it("true exactly for the states with something to offer", () => {
    const verdicts: Record<InstallState, boolean> = {
      promptable: true,
      "ios-safari": true,
      "ios-other": true,
      installed: false,
      unavailable: false,
    };
    for (const [state, expected] of Object.entries(verdicts)) {
      expect(isInstallable(state as InstallState)).toBe(expected);
    }
  });
});

/**
 * M7: exactly ONE install-sheet host, owned by App. A second InstallSheet renderer
 * (Settings used to keep its own) doubles the dialog and reopens the empty-chrome gap
 * M5 closed — this scan keeps one from coming back anywhere in src/. It matches the JSX
 * form only, so importing the component or naming it in prose stays legal.
 */
describe("single install-sheet host", () => {
  it("App.tsx is the only file rendering an InstallSheet element", () => {
    const SRC = join(import.meta.dir, "..");
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));
    const renderers = files.filter((f) => /<InstallSheet[\s/>]/.test(readFileSync(join(SRC, f), "utf8")));
    expect(renderers).toEqual(["App.tsx"]);
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

/**
 * The deferred event is SINGLE-USE, so promptInstall must drop it whatever the native dialog
 * does. Chromium throws InvalidStateError on an already-consumed event; if that escaped, the
 * module would keep a dead event, the state would stay "promptable" forever and the Drawer row
 * and Settings card would stay visible while every click did nothing.
 *
 * A window stub on globalThis — bun test has no DOM; it lets us drive the real capture listener
 * that initInstallPrompt registers, which is the only way to put an event into the module.
 */
describe("promptInstall", () => {
  const handlers = new Map<string, (e: unknown) => void>();
  const fire = (e: unknown) => handlers.get("beforeinstallprompt")!(e);

  beforeAll(() => {
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (type: string, fn: (e: unknown) => void) => void handlers.set(type, fn),
      navigator: {},
      matchMedia: () => ({ matches: false }),
    };
    initInstallPrompt();
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("with no captured event → unavailable", async () => {
    expect(await promptInstall()).toBe("unavailable");
  });

  it("consumes the captured event once and reports the outcome", async () => {
    let prompts = 0;
    fire({
      preventDefault: () => {},
      prompt: async () => void prompts++,
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    expect(await promptInstall()).toBe("dismissed");
    expect(await promptInstall()).toBe("unavailable"); // dropped: single-use
    expect(prompts).toBe(1);
  });

  it("a THROWING prompt() still clears the event instead of pinning a dead one", async () => {
    let prompts = 0;
    fire({
      preventDefault: () => {},
      prompt: async () => {
        prompts++;
        throw Object.assign(new Error("the event was already used"), { name: "InvalidStateError" });
      },
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    expect(await promptInstall()).toBe("unavailable"); // reported, not re-thrown
    expect(await promptInstall()).toBe("unavailable");
    expect(prompts).toBe(1); // the dead event was dropped, not retried
  });

  it("a rejecting userChoice is absorbed the same way", async () => {
    let prompts = 0;
    const userChoice = Promise.reject(new Error("gone"));
    userChoice.catch(() => {}); // it sits idle until runPrompt awaits it — keep bun from flagging it
    fire({
      preventDefault: () => {},
      prompt: async () => void prompts++,
      userChoice,
    });
    expect(await promptInstall()).toBe("unavailable");
    expect(prompts).toBe(1);
    expect(await promptInstall()).toBe("unavailable");
    expect(prompts).toBe(1);
  });

  /** Non-hook mirror of the store — for reads outside render (Onboarding's finish()). */
  it("getInstallState reads the live snapshot without a hook", async () => {
    expect(getInstallState()).toBe("unavailable");
    fire({
      preventDefault: () => {},
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    expect(getInstallState()).toBe("promptable");
    await promptInstall();
    expect(getInstallState()).toBe("unavailable"); // consumed — the snapshot moved with it
  });
});
