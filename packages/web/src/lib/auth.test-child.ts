export {};

const scenario = process.argv[2] ?? "success";
const testLocation = { origin: "https://enveo.test", protocol: "https:", host: "enveo.test" } as Location;
(globalThis as { location?: Location }).location = testLocation;
(globalThis as { window?: Window & typeof globalThis }).window = { location: testLocation } as Window & typeof globalThis;

let observed: { method: string; path: string; cleanupHeader: string | null } | null = null;
let coordinationMarker = "live";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  observed = {
    method: request.method,
    path: new URL(request.url).pathname,
    cleanupHeader: request.headers.get("x-enveo-clear-site-data"),
  };
  if (observed.cleanupHeader) coordinationMarker = "erased-during-response";
  if (scenario === "network") throw new TypeError("provider prose");
  if (scenario === "error") {
    return new Response(JSON.stringify({ code: "INTERNAL_SERVER_ERROR", message: "provider prose" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { endSession } = await import("./auth");
let outcome = "ok";
try {
  await endSession();
} catch (error) {
  outcome = (error as Error).message;
}
process.stdout.write(JSON.stringify({ observed, outcome, coordinationMarker }));
