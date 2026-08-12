/**
 * BYOK model availability check (backlog §1b) — `GET /v1/models` with the user's key, DIRECTLY
 * from the browser (CSP already allows api.openai.com for the byok chat calls; the key never
 * touches our server). The answer is matched against the CURATED registry only and immediately
 * reduced to a verdict — the model list itself is never stored, never rendered and never used
 * to populate the picker (the endpoint carries no capability or price metadata, and untested
 * models would break structured-output parity).
 *
 * The check is ADVISORY and fails soft by design:
 *  - "checked"      — a definite 200 verdict; ONLY this state may disable a picker option,
 *  - "invalid_key"  — OpenAI rejected the key itself (401/403): the user should fix the key,
 *                     so no per-model conclusion is drawn,
 *  - "unknown"      — anything else (offline, 5xx, rate limit, unexpected body): the picker
 *                     stays fully selectable, at worst the chat call fails later with its own
 *                     honest error code (lib/openai.ts owns that contract).
 * checkModelAvailability never throws — a rejected promise from a background availability probe
 * must not surface as an unhandled error in the settings screen.
 */
import { timeoutSignal } from "./timeoutSignal";

export type ModelAvailability = { state: "invalid_key" } | { state: "unknown" } | { state: "checked"; available: ReadonlySet<string> };

const MODELS_URL = "https://api.openai.com/v1/models";
const CHECK_TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Pure verdict from a status + parsed body — the tested core of the check. */
export function availabilityVerdict(status: number, body: unknown, curated: readonly string[]): ModelAvailability {
  if (status === 401 || status === 403) return { state: "invalid_key" };
  if (status !== 200) return { state: "unknown" };
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { state: "unknown" };
  const ids = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id === "string") ids.add(id);
  }
  return { state: "checked", available: new Set(curated.filter((m) => ids.has(m))) };
}

export async function checkModelAvailability(key: string, curated: readonly string[], fetchFn: FetchLike = fetch): Promise<ModelAvailability> {
  const t = timeoutSignal(CHECK_TIMEOUT_MS);
  try {
    const res = await fetchFn(MODELS_URL, { method: "GET", headers: { authorization: `Bearer ${key}` }, signal: t.signal });
    if (res.status === 401 || res.status === 403) return { state: "invalid_key" };
    if (res.status !== 200) return { state: "unknown" };
    return availabilityVerdict(res.status, await res.json(), curated);
  } catch {
    return { state: "unknown" }; // offline, DNS, abort, or a 200 whose body is not JSON
  } finally {
    t.clear();
  }
}
