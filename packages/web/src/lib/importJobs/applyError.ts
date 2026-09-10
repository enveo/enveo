import { apiErrorMessage } from "../api";
import { type Message, msg } from "../i18n";

export const WEB_LOCKS_UNAVAILABLE_MESSAGE = msg(
  "This browser cannot safely coordinate import changes across tabs. Keep this review open and try again in a supported browser.",
);

export function importApplyErrorMessage(error: unknown, translate: (message: Message) => string): string {
  if (String((error as Error).message ?? error) === "import_web_locks_unavailable") return translate(WEB_LOCKS_UNAVAILABLE_MESSAGE);
  if (String((error as Error).message ?? error) === "import_review_incomplete")
    return translate(msg("Complete or uncheck the unfinished rows before adding transactions."));
  return apiErrorMessage(error);
}
