import type { AccountPreferences, AccountPreferencesPatch } from "@enveo/shared";

export type AccountPreferencesResponse = AccountPreferences & { revision: number };

async function request(method: "GET" | "PATCH", body?: unknown): Promise<AccountPreferencesResponse> {
  const response = await fetch("/api/preferences/account", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`);
  return response.json() as Promise<AccountPreferencesResponse>;
}

export const getAccountPreferencesRemote = (): Promise<AccountPreferencesResponse> => request("GET");

export const patchAccountPreferencesRemote = (userId: string, patch: AccountPreferencesPatch): Promise<AccountPreferencesResponse> =>
  request("PATCH", { userId, patch });
