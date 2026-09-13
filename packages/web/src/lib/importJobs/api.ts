import type { ImportCompletion } from "@enveo/shared";
import { type AiLocale, type ImportJobDetail, type ImportJobSummary, importJobDetailSchema, importJobSummarySchema } from "@enveo/shared";
import { http } from "../api";

const summaryListSchema = importJobSummarySchema.array();
const detail = (method: string, path: string, body?: unknown): Promise<ImportJobDetail> =>
  http<unknown>(method, path, body).then((value) => importJobDetailSchema.parse(value));

export const importJobsApi = {
  create: (input: { id: string; budgetId: string; accountId: string; locale: AiLocale; images: string[] }) => detail("POST", "/import/jobs", input),
  list: (): Promise<ImportJobSummary[]> => http<unknown>("GET", "/import/jobs").then((value) => summaryListSchema.parse(value)),
  get: (id: string) => detail("GET", `/import/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string, budgetId: string) => detail("POST", `/import/jobs/${encodeURIComponent(id)}/cancel`, { budgetId }),
  retry: (id: string, budgetId: string) => detail("POST", `/import/jobs/${encodeURIComponent(id)}/retry`, { budgetId }),
  removeMany: (ids: string[], budgetId: string) => http<{ deleted: number }>("POST", "/import/jobs/delete", { budgetId, ids }),
  complete: (id: string, input: ImportCompletion & { budgetId: string }) => detail("POST", `/import/jobs/${encodeURIComponent(id)}/complete`, input),
};
