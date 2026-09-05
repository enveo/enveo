/**
 * iOS Safari auto-zooms the page whenever a focused form control renders text smaller than
 * 16px, and Enveo's fields are set at 13–15px on purpose (the type scale is the design). On a
 * phone that zoom hides the rest of the sheet behind the keyboard — the amount pad, the
 * Add form's name field — and stays zoomed after the field blurs.
 *
 * The fix is `maximum-scale=1` in the viewport meta, applied ONLY on iOS WebKit: Safari
 * reads it as "do not zoom on focus" while pinch-to-zoom keeps working (Safari has ignored
 * `maximum-scale`/`user-scalable` for the user's own gestures since iOS 10). Other engines
 * honour `maximum-scale` literally and would lose pinch zoom, so they never see it.
 */

/** iPhone/iPod, plus iPad — which reports a Mac UA since iPadOS 13 but has touch points. */
export function isIosWebKit(userAgent: string, maxTouchPoints: number): boolean {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** The viewport content with `maximum-scale=1` appended once; unchanged when already present. */
export function viewportWithoutFocusZoom(content: string): string {
  if (/(^|,)\s*maximum-scale\s*=/i.test(content)) return content;
  const trimmed = content.trim().replace(/,\s*$/, "");
  return trimmed ? `${trimmed}, maximum-scale=1` : "maximum-scale=1";
}

export function preventIosFocusZoom(doc: Document = document, nav: Navigator = navigator): void {
  if (!isIosWebKit(nav.userAgent, nav.maxTouchPoints ?? 0)) return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  meta.content = viewportWithoutFocusZoom(meta.content);
}
