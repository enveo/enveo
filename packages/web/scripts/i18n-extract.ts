/**
 * Regenerates src/lib/i18n/messages.generated.ts from the source.
 * Run: `bun run i18n:extract` (i18n.test.ts fails if the committed file is stale).
 */
import { ambiguous, extractSites, writeMessages } from "./i18n-extract-lib";

console.log(`extracted ${await writeMessages()} messages`);

// The design's §2 warning, surfaced where people actually look: whoever changes copy runs this.
const candidates = ambiguous(await extractSites());
if (candidates.length > 0) {
  console.log(`${candidates.length} ambiguity candidates (short messages reused across call sites) — bun run i18n:ambiguity`);
}
