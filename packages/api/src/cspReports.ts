export const CSP_REPORT_PATH = "/api/security/csp-report";
export const CSP_REPORT_MAX_BYTES = 16_384;
const MAX_REPORTS = 20;
const MAX_DIRECTIVE_LENGTH = 128;
const PATH_CLASSES = new Set(["transactions", "budget", "accounts", "goals", "settings", "login", "onboarding", "import"]);

export type SanitizedCspEvent = {
  directive: string;
  disposition: "enforce" | "report";
  documentOrigin: string;
  documentPathClass: string;
  blockedKind: string;
  blockedOrigin?: string;
  browser: string;
};

type RecordLike = Record<string, unknown>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function classifyDocument(value: string): { origin: string; path: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { origin: "unknown", path: "/unknown" };
    const segment = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return { origin: url.origin, path: segment && PATH_CLASSES.has(segment) ? `/${segment}` : segment ? "/other" : "/" };
  } catch {
    return { origin: "unknown", path: "/unknown" };
  }
}

function classifyBlocked(value: string, documentOrigin: string): { kind: string; origin?: string } {
  if (!value) return { kind: "none" };
  if (value.startsWith("data:")) return { kind: "data" };
  if (value.startsWith("blob:")) return { kind: "blob" };
  if (value === "inline") return { kind: "inline" };
  if (value === "eval") return { kind: "eval" };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "other" };
    const origin = url.origin;
    return origin === documentOrigin ? { kind: "same-origin" } : { kind: "cross-origin", origin };
  } catch {
    return { kind: "other" };
  }
}

function browserName(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/Firefox\//i.test(ua)) return "firefox";
  if (/(Chrome|Chromium|Edg|OPR)\//i.test(ua)) return "chromium";
  if (/Safari\//i.test(ua)) return "safari";
  return "other";
}

function eventFrom(report: RecordLike, ua: string | null, reportingApi: boolean): SanitizedCspEvent | null {
  const body = reportingApi && report.body && typeof report.body === "object" ? (report.body as RecordLike) : report;
  const directiveRaw = stringValue(body[reportingApi ? "effectiveDirective" : "effective-directive"]);
  if (!/^[A-Za-z0-9-]+$/.test(directiveRaw) || directiveRaw.length > MAX_DIRECTIVE_LENGTH) return null;
  const directive = directiveRaw;
  const dispositionRaw = stringValue(body.disposition);
  const disposition: "enforce" | "report" = dispositionRaw === "enforce" ? "enforce" : "report";
  const document = classifyDocument(stringValue(body[reportingApi ? "documentURL" : "document-uri"]));
  const blocked = classifyBlocked(stringValue(body[reportingApi ? "blockedURL" : "blocked-uri"]), document.origin);
  return {
    directive,
    disposition,
    documentOrigin: document.origin,
    documentPathClass: document.path,
    blockedKind: blocked.kind,
    ...(blocked.origin ? { blockedOrigin: blocked.origin } : {}),
    browser: browserName(ua),
  };
}

export function parseCspReports(contentType: string | null, raw: string, userAgent: string | null): SanitizedCspEvent[] {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/csp-report" && mediaType !== "application/reports+json") return [];
  if (new TextEncoder().encode(raw).byteLength > CSP_REPORT_MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const reportingApi = mediaType === "application/reports+json";
  const reports: unknown[] = reportingApi
    ? Array.isArray(parsed)
      ? parsed
      : []
    : parsed && typeof parsed === "object" && (parsed as RecordLike)["csp-report"] && typeof (parsed as RecordLike)["csp-report"] === "object"
      ? [(parsed as RecordLike)["csp-report"]]
      : [];
  return reports.slice(0, MAX_REPORTS).flatMap((report) => {
    if (!report || typeof report !== "object") return [];
    if (reportingApi && stringValue((report as RecordLike).type) !== "csp-violation") return [];
    const event = eventFrom(report as RecordLike, userAgent, reportingApi);
    return event ? [event] : [];
  });
}
