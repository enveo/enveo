/**
 * Compile-time canary for `ReportShell`'s variant union (see `reportKit.tsx`'s
 * `ReportShellProps`).
 *
 * Never rendered or executed — this file exists purely so `tsc` walks it. `bun test` strips
 * types and would pass regardless of what's below; the enforcement is `bun run typecheck`
 * (root, §3a) → `bun run --cwd packages/web typecheck`, which CI runs through `bun run
 * verify:ci`. Each `@ts-expect-error` FAILS the build two different ways, both proven in
 * task-4's report: delete the directive comment itself and the underlying error it was
 * suppressing (a missing required prop, TS2322) surfaces directly; instead weaken
 * `ReportShellProps`' union so the call below becomes valid and the now-unused directive fails
 * with TS2578 ("Unused '@ts-expect-error' directive"). Either failure mode is what makes this a
 * guard rather than a comment — mirroring `_rejectPooledDbAtCompileTime` in
 * `packages/api/src/db/operationLock.test.ts`.
 *
 * This file has no `.test.ts` suffix match for either web tsconfig's include/exclude glob —
 * it's `.tsx` (JSX needs it), and both globs match only a literal `.test.ts` ending. It's
 * picked up by `tsconfig.json` (the app project): that config's `exclude` is a double-star glob
 * ending in `.test.ts` under `src`, which does not match a `.tsx` filename, so directory
 * inclusion of `src` still reaches this file. It is NOT matched by `tsconfig.test.json`'s
 * `include` (the same `.test.ts`-ending glob), which is fine — nothing here uses `bun:test`.
 */
import { ReportShell } from "./reportKit";

export function _reportShellVariantCanary() {
  return [
    // @ts-expect-error a subscreen (the default variant) must supply onBack — omitting it would
    // leave the rendered back-chevron button permanently dead.
    <ReportShell key="subscreen" month="2026-08" onPrev={() => {}} onNext={() => {}} title="x" eyebrow="e" hero="h">
      {null}
    </ReportShell>,
    // @ts-expect-error a hub must supply onMenu — omitting it would leave the header's menu
    // button permanently dead.
    <ReportShell key="hub" variant="hub" month="2026-08" onPrev={() => {}} onNext={() => {}} eyebrow="e" hero="h">
      {null}
    </ReportShell>,
  ];
}
