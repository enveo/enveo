



import { ambiguous, extractSites, writeMessages } from "./i18n-extract-lib";

console.log(`extracted ${await writeMessages()} messages`);

 
const candidates = ambiguous(await extractSites());
if (candidates.length > 0) {
  console.log(`${candidates.length} ambiguity candidates (short messages reused across call sites) — bun run i18n:ambiguity`);
}
