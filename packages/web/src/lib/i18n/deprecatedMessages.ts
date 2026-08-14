import { msg } from "./index";

/** Translation-memory entries kept while the settings/AI migration lands.
 * They are not imported by the application and therefore add nothing to the
 * bundle; retaining them avoids discarding reviewed community translations. */
export const DEPRECATED_MESSAGES = [
  msg("A new own key can be added after secure credential vault migration is available."),
  msg("AI is off — suggestions run locally on rules; nothing leaves this device."),
  msg("AI requests go to OpenAI through the app server (operator's key)."),
  msg("An existing browser key is present and waiting for migration to the secure credential vault."),
  msg("Checking which models your key can use…"),
  msg("Could not check model availability right now — every tier stays selectable."),
  msg("Existing browser credentials remain read-only until secure vault migration completes."),
  msg("Migration status: pending secure server acknowledgement."),
  msg("Mode"),
  msg("No own key is configured. Secure credential management will become available after the vault migration."),
  msg("Not available with your OpenAI key."),
  msg("Off"),
  msg("off"),
  msg("OpenAI rejected this key — model availability could not be checked."),
  msg("Own OpenAI credential"),
  msg("Own OpenAI is unavailable until a key is stored in the secure credential vault."),
  msg("Own key"),
  msg("Server"),
  msg("The AI provider and model follow this budget on every device."),
  msg("The app talks to OpenAI directly from this browser using your own key — bypassing the server."),
  msg("The server has no OpenAI key configured — server mode is unavailable. Use an existing own key or keep AI on rules."),
  msg("Use the existing own key"),
] as const;
