import type { AiLocale, ClientLedger, ReconciledImportRecognitionResult } from "@enveo/shared";
import type { AiProvider } from "./aiProvider/contracts";

/* The UI language goes to the prompt builders AS IS (a `Lang` is a BCP-47 tag and AiLocale takes
   any of them since 2.2.0): the model names, notes and rationales come back in the user's
   language, whether or not we ship a dictionary for it. */

/**
 * No usable model on this device (AI off, or byok with no key yet). Carries a CODE, not prose:
 * it reaches the user through apiErrorMessage() like every other client-side sentinel, and
 * lib/api.ts owns the wording in each locale (a sentence thrown here would render English in a
 * Polish UI — the regression api.test.ts guards).
 */
export class AiConsentRequired extends Error {
  constructor() {
    super("ai_consent_required");
    this.name = "AiConsentRequired";
  }
}

export async function runImportExtract(args: {
  images: string[];
  locale: AiLocale;
  ledger: ClientLedger;
  accountId: string;
  provider: AiProvider;
}): Promise<ReconciledImportRecognitionResult> {
  const { images, locale, ledger, accountId, provider } = args;
  const status = await provider.status();
  if (!status.capabilities.has("screenshot-import")) throw new AiConsentRequired();
  return provider.extractImport({ images, locale, ledger, accountId });
}
