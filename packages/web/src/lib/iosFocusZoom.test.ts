import { describe, expect, test } from "bun:test";
import { isIosWebKit, preventIosFocusZoom, viewportWithoutFocusZoom } from "./iosFocusZoom";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

describe("isIosWebKit", () => {
  test("recognises iPhone, and iPad behind a Mac user agent by its touch points", () => {
    expect(isIosWebKit(IPHONE, 5)).toBe(true);
    expect(isIosWebKit(IPAD_AS_MAC, 5)).toBe(true);
  });

  test("leaves Android and a real Mac alone", () => {
    expect(isIosWebKit(ANDROID, 5)).toBe(false);
    expect(isIosWebKit(IPAD_AS_MAC, 0)).toBe(false);
  });
});

describe("viewportWithoutFocusZoom", () => {
  test("appends maximum-scale=1 once", () => {
    const once = viewportWithoutFocusZoom(VIEWPORT);
    expect(once).toBe(`${VIEWPORT}, maximum-scale=1`);
    expect(viewportWithoutFocusZoom(once)).toBe(once);
  });

  test("keeps an explicit maximum-scale the page already declares", () => {
    expect(viewportWithoutFocusZoom("width=device-width, maximum-scale=2")).toBe("width=device-width, maximum-scale=2");
  });
});

describe("preventIosFocusZoom", () => {
  const fakeDocument = (content: string | null) => {
    const meta = content === null ? null : { content };
    return { doc: { querySelector: () => meta } as unknown as Document, meta };
  };

  test("rewrites the viewport meta on iOS only", () => {
    const ios = fakeDocument(VIEWPORT);
    preventIosFocusZoom(ios.doc, { userAgent: IPHONE, maxTouchPoints: 5 } as Navigator);
    expect(ios.meta?.content).toBe(`${VIEWPORT}, maximum-scale=1`);

    const android = fakeDocument(VIEWPORT);
    preventIosFocusZoom(android.doc, { userAgent: ANDROID, maxTouchPoints: 5 } as Navigator);
    expect(android.meta?.content).toBe(VIEWPORT);
  });

  test("tolerates a page without a viewport meta", () => {
    const none = fakeDocument(null);
    expect(() => preventIosFocusZoom(none.doc, { userAgent: IPHONE, maxTouchPoints: 5 } as Navigator)).not.toThrow();
  });
});
