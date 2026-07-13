/**
 * Regenerates src/lib/i18n/messages.generated.ts from the source.
 * Run: `bun run i18n:extract` (i18n.test.ts fails if the committed file is stale).
 */
import { writeMessages } from "./i18n-extract-lib";

console.log(`extracted ${await writeMessages()} messages`);
