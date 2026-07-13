/**
 * Ambiguity report (design §2): short messages reused at several call sites, where ONE translation
 * must serve every context — the "Save" verb/noun trap. A warning, not a gate: read it before
 * shipping a copy change, and rephrase anything whose part of speech is not obvious from the word
 * alone (a whole sentence with a {placeholder} beats fragments glued together in JSX).
 *
 * Run: `bun run i18n:ambiguity`
 */
import { ambiguous, extractSites } from "./i18n-extract-lib";

const report = ambiguous(await extractSites());

for (const { message, sites } of report) {
  console.log(`${JSON.stringify(message)} — ${sites.length} call sites`);
  for (const at of sites) console.log(`    ${at}`);
}
console.log(`\n${report.length} ambiguity candidates (a warning, not an error).`);
