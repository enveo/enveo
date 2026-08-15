import { msg } from "./index";

/** Translation-memory entries kept while the settings/AI migration lands.
 * They are not imported by the application and therefore add nothing to the
 * bundle; retaining them avoids discarding reviewed community translations. */
export const DEPRECATED_MESSAGES = [
  msg("AI is off — suggestions run locally on rules; nothing leaves this device."),
  msg("AI requests go to OpenAI through the app server (operator's key)."),
  msg("Checking which models your key can use…"),
  msg("Could not check model availability right now — every tier stays selectable."),
  msg("Mode"),
  msg("Not available with your OpenAI key."),
  msg("Off"),
  msg("off"),
  msg("OpenAI rejected this key — model availability could not be checked."),
  msg("Own OpenAI credential"),
  msg("Own key"),
  msg("Server"),
  msg("The AI provider and model follow this budget on every device."),
  msg("The app talks to OpenAI directly from this browser using your own key — bypassing the server."),
  msg("Use the existing own key"),
] as const;
