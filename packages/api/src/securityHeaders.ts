 
export const API_CACHE_CONTROL = "no-store";
export const CLEAR_SITE_DATA_REQUEST_HEADER = "x-enveo-clear-site-data";

const CLEAR_SITE_DATA_REQUEST_VALUE = "persistent-current-owner";





export function shouldClearSiteData(request: Request, status: number): boolean {
  return (
    request.method === "POST" &&
    new URL(request.url).pathname === "/api/auth/sign-out" &&
    status >= 200 &&
    status < 300 &&
    request.headers.get(CLEAR_SITE_DATA_REQUEST_HEADER) === CLEAR_SITE_DATA_REQUEST_VALUE
  );
}
