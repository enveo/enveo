import { apiErrorMessage } from "../api";
import { msg } from "../i18n";

export const WEB_LOCKS_UNAVAILABLE_MESSAGE = msg(
  "This browser cannot safely coordinate import changes across tabs. Keep this review open and try again in a supported browser.",
);

export function importApplyErrorMessage(error: unknown, translate: (message: typeof WEB_LOCKS_UNAVAILABLE_MESSAGE) => string): string {
  if (String((error as Error).message ?? error) === "import_web_locks_unavailable") return translate(WEB_LOCKS_UNAVAILABLE_MESSAGE);
  return apiErrorMessage(error);
}
