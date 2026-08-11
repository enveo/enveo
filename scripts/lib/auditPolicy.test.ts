/**
 * Pure tests for the dependency-audit gate (§3a / §0a "Audit policy and exception record").
 *
 * Every outcome the policy has to survive is a fixture here: zero findings, a forbidden high,
 * an exactly-matching accepted moderate, an unknown advisory, an expired entry, a stale entry,
 * a duplicate entry, and malformed input. The process layer (scripts/audit.ts) only spawns
 * `bun audit --json` and hands the text to these functions.
 */
import { describe, expect, it } from "bun:test";
import {
  evaluateAudit,
  parseAuditJson,
  parseBunLock,
  parsePolicy,
  type AuditPolicy,
  type InstalledIndex,
} from "./auditPolicy";

const NOW = new Date("2026-08-11T12:00:00Z");

const ESBUILD_JSON = JSON.stringify({
  esbuild: [
    {
      id: 1102341,
      url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
      title: "esbuild enables any website to send any requests to the development server",
      severity: "moderate",
      vulnerable_versions: "<=0.24.2",
      cwe: ["CWE-346"],
      cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N" },
    },
  ],
});

const HIGH_JSON = JSON.stringify({
  hono: [
    {
      id: 999,
      url: "https://github.com/advisories/GHSA-8j4g-w8fx-2239",
      title: "Hono CORS preflight denial of service",
      severity: "high",
      vulnerable_versions: "<4.12.34",
    },
  ],
});

const installed: InstalledIndex = new Map([
  [
    "esbuild",
    [
      { version: "0.25.12", path: "esbuild" },
      { version: "0.18.20", path: "@esbuild-kit/core-utils/esbuild" },
      { version: "0.28.2", path: "vite/esbuild" },
    ],
  ],
  ["hono", [{ version: "4.12.27", path: "hono" }]],
]);

function policyWith(overrides: Record<string, unknown> = {}): AuditPolicy {
  const parsed = parsePolicy(
    JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          advisoryId: "GHSA-67mh-4wv8-2f99",
          package: "esbuild",
          severity: "moderate",
          vulnerableVersions: "<=0.24.2",
          installed: [{ version: "0.18.20", path: "@esbuild-kit/core-utils/esbuild" }],
          scope: "build tooling only",
          reachability: "the advisory concerns esbuild's dev server, which this path never starts",
          mitigation: "none needed; not reachable",
          fixedVersion: "0.25.0",
          owner: "Lukasz",
          rationale: "drizzle-kit pins the deprecated wrapper to ~0.18.20",
          addedOn: "2026-08-11",
          expires: "2026-11-08",
          ...overrides,
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const EMPTY_POLICY: AuditPolicy = { schemaVersion: 1, exceptions: [] };

describe("parseAuditJson", () => {
  it("reads Bun's package-keyed shape and derives the advisory id from the URL", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value[0]).toMatchObject({
      package: "esbuild",
      advisoryId: "GHSA-67mh-4wv8-2f99",
      severity: "moderate",
      vulnerableVersions: "<=0.24.2",
    });
  });

  it("treats `{}` as zero findings", () => {
    const parsed = parseAuditJson("{}\n");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(0);
  });

  it("fails closed on malformed JSON, on empty output and on a non-object root", () => {
    for (const text of ["", "   ", "not json", "[]", "null", '"x"']) {
      expect(parseAuditJson(text).ok).toBe(false);
    }
  });

  it("fails closed when a required field is missing or the schema changed", () => {
    const noSeverity = JSON.stringify({
      esbuild: [{ id: 1, url: "https://github.com/advisories/GHSA-a-b-c", title: "t" }],
    });
    const unknownSeverity = JSON.stringify({
      esbuild: [
        {
          id: 1,
          url: "https://github.com/advisories/GHSA-a-b-c",
          title: "t",
          severity: "spicy",
          vulnerable_versions: "<1",
        },
      ],
    });
    const badUrl = JSON.stringify({
      esbuild: [
        { id: 1, url: "https://example.com/x", title: "t", severity: "low", vulnerable_versions: "<1" },
      ],
    });

    expect(parseAuditJson(noSeverity).ok).toBe(false);
    expect(parseAuditJson(unknownSeverity).ok).toBe(false);
    expect(parseAuditJson(badUrl).ok).toBe(false);
  });
});

describe("parseBunLock", () => {
  it("reads the JSONC lockfile and indexes every installed instance by package", () => {
    const lock = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "enveo", }, },
  "packages": {
    "esbuild": ["esbuild@0.25.12", "", {}, "sha512-x"],
    "@esbuild-kit/core-utils/esbuild": ["esbuild@0.18.20", "", {}, "sha512-y"],
    "@enveo/shared": ["@enveo/shared@workspace:packages/shared"],
  },
}`;

    const parsed = parseBunLock(lock);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.get("esbuild")).toEqual([
      { version: "0.25.12", path: "esbuild" },
      { version: "0.18.20", path: "@esbuild-kit/core-utils/esbuild" },
    ]);
    expect(parsed.value.get("@enveo/shared")).toEqual([
      { version: "workspace:packages/shared", path: "@enveo/shared" },
    ]);
  });

  it("fails closed on an unsupported lockfileVersion so a format change is reviewed", () => {
    const parsed = parseBunLock('{ "lockfileVersion": 2, "packages": {} }');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("lockfileVersion");
  });

  it("fails closed on unreadable content", () => {
    expect(parseBunLock("").ok).toBe(false);
    expect(parseBunLock("nonsense").ok).toBe(false);
  });

  it("parses the repository's own bun.lock and finds the pinned esbuild instances", async () => {
    const text = await Bun.file(new URL("../../bun.lock", import.meta.url)).text();
    const parsed = parseBunLock(text);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const versions = (parsed.value.get("esbuild") ?? []).map((i) => i.version);
    expect(versions).toContain("0.18.20");
  });
});

describe("evaluateAudit", () => {
  it("passes with zero findings and an empty policy", () => {
    const report = evaluateAudit({ advisories: [], installed, policy: EMPTY_POLICY, now: NOW });

    expect(report.ok).toBe(true);
    expect(report.entries).toHaveLength(0);
    expect(report.problems).toHaveLength(0);
  });

  it("rejects a high advisory even when an exception for it is smuggled in", () => {
    const parsedHigh = parseAuditJson(HIGH_JSON);
    expect(parsedHigh.ok).toBe(true);
    if (!parsedHigh.ok) return;

    // parsePolicy already refuses to LOAD a critical/high entry, so this hand-built policy is
    // defence in depth: the evaluator must reject the advisory before it ever looks for one.
    const policy: AuditPolicy = {
      schemaVersion: 1,
      exceptions: [
        {
          ...policyWith().exceptions[0]!,
          advisoryId: "GHSA-8j4g-w8fx-2239",
          package: "hono",
          severity: "high",
          vulnerableVersions: "<4.12.34",
          installed: [{ version: "4.12.27", path: "hono" }],
        },
      ],
    };

    const report = evaluateAudit({ advisories: parsedHigh.value, installed, policy, now: NOW });

    expect(report.ok).toBe(false);
    expect(report.entries[0]?.verdict).toBe("rejected");
    expect(report.problems.join("\n")).toContain("no exception path");
  });

  it("accepts a moderate advisory on an exact, unexpired entry and reports days until expiry", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);
    if (!parsed.ok) throw new Error(parsed.error);

    const report = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: policyWith(),
      now: NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.entries[0]?.verdict).toBe("accepted");
    expect(report.entries[0]?.daysUntilExpiry).toBe(89);
    expect(report.entries[0]?.installed).toEqual([
      { version: "0.18.20", path: "@esbuild-kit/core-utils/esbuild" },
    ]);
  });

  it("rejects an unknown advisory (no policy entry at all)", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);
    if (!parsed.ok) throw new Error(parsed.error);

    const report = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: EMPTY_POLICY,
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("no reviewed policy entry");
  });

  it("rejects an expired entry", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);
    if (!parsed.ok) throw new Error(parsed.error);

    const report = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: policyWith(),
      now: new Date("2026-11-09T00:00:00Z"),
    });

    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("expired");
  });

  it("rejects a severity increase and a package/version mismatch", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);
    if (!parsed.ok) throw new Error(parsed.error);

    const bumped = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: policyWith({ severity: "low" }),
      now: NOW,
    });
    expect(bumped.ok).toBe(false);
    expect(bumped.problems.join("\n")).toContain("severity");

    const wrongRange = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: policyWith({ vulnerableVersions: "<=0.20.0" }),
      now: NOW,
    });
    expect(wrongRange.ok).toBe(false);

    const wrongInstall = evaluateAudit({
      advisories: parsed.value,
      installed,
      policy: policyWith({ installed: [{ version: "0.18.20", path: "somewhere/else" }] }),
      now: NOW,
    });
    expect(wrongInstall.ok).toBe(false);
    expect(wrongInstall.problems.join("\n")).toContain("installed");
  });

  it("rejects a stale entry that matches no installed finding", () => {
    const report = evaluateAudit({
      advisories: [],
      installed,
      policy: policyWith(),
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.staleExceptions).toEqual(["GHSA-67mh-4wv8-2f99"]);
    expect(report.problems.join("\n")).toContain("stale");
  });

  it("rejects an advisory whose installed version cannot be located in the lockfile", () => {
    const parsed = parseAuditJson(ESBUILD_JSON);
    if (!parsed.ok) throw new Error(parsed.error);

    const report = evaluateAudit({
      advisories: parsed.value,
      installed: new Map([["esbuild", [{ version: "0.25.12", path: "esbuild" }]]]),
      policy: policyWith(),
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("no installed version");
  });
});

describe("parsePolicy", () => {
  it("rejects a duplicate exception for the same advisory", () => {
    const entry = policyWith().exceptions[0];
    const parsed = parsePolicy(JSON.stringify({ schemaVersion: 1, exceptions: [entry, entry] }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("duplicate");
  });

  it("rejects an unknown schema version so a policy format change is reviewed", () => {
    expect(parsePolicy(JSON.stringify({ schemaVersion: 2, exceptions: [] })).ok).toBe(false);
  });

  it("rejects an invalid date, an expiry before the entry date and a window over 90 days", () => {
    expect(parsePolicy(JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ ...policyWith().exceptions[0], expires: "2026-13-45" }],
    })).ok).toBe(false);

    expect(parsePolicy(JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ ...policyWith().exceptions[0], expires: "2026-08-10" }],
    })).ok).toBe(false);

    const tooLong = parsePolicy(JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ ...policyWith().exceptions[0], expires: "2026-12-01" }],
    }));
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error).toContain("90 days");
  });

  it("rejects an addedOn in the future, which would smuggle in a long suppression", () => {
    // addedOn is self-declared. Measuring the 90-day cap from it alone lets
    // addedOn 2027-03-01 / expires 2027-05-29 compute an 89-day window while actually
    // suppressing the advisory for ~290 days from today.
    const parsed = parsePolicy(
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          { ...policyWith().exceptions[0], addedOn: "2027-03-01", expires: "2027-05-29" },
        ],
      }),
      NOW,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("future");
  });

  it("caps the REMAINING window, not `expires - addedOn`", () => {
    // Inside the skew tolerance, so addedOn is accepted — but exactly 90 days from addedOn is
    // 91 days from today. Measuring from addedOn alone would pass this; measuring the
    // suppression that still has to run rejects it.
    const parsed = parsePolicy(
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          { ...policyWith().exceptions[0], addedOn: "2026-08-12", expires: "2026-11-10" },
        ],
      }),
      NOW, // 2026-08-11
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("90 days");
  });

  it("does not let an over-long entry become acceptable by ageing", () => {
    // Declared window is 210 days. Once only 30 days remain, a "remaining window" rule alone
    // would accept it; the declared window must stay capped too.
    const parsed = parsePolicy(
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          { ...policyWith().exceptions[0], addedOn: "2026-02-01", expires: "2026-08-30" },
        ],
      }),
      NOW, // 2026-08-11, i.e. 19 days left
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("90 days");
  });

  it("tolerates a small clock skew on addedOn", () => {
    const parsed = parsePolicy(
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          { ...policyWith().exceptions[0], addedOn: "2026-08-12", expires: "2026-11-08" },
        ],
      }),
      NOW, // 2026-08-11 — the entry is dated "tomorrow", within tolerance
    );

    expect(parsed.ok).toBe(true);
  });

  it("rejects a critical/high exception outright — those have no exception path", () => {
    const parsed = parsePolicy(JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ ...policyWith().exceptions[0], severity: "high" }],
    }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("critical/high");
  });

  it("requires the reviewer fields (owner, rationale, reachability, mitigation, scope)", () => {
    for (const field of ["owner", "rationale", "reachability", "mitigation", "scope"]) {
      const parsed = parsePolicy(JSON.stringify({
        schemaVersion: 1,
        exceptions: [{ ...policyWith().exceptions[0], [field]: "" }],
      }));
      expect(parsed.ok).toBe(false);
    }
  });

  it("parses the repository's own reviewed policy file", async () => {
    const text = await Bun.file(new URL("../../security/audit-policy.json", import.meta.url)).text();
    const parsed = parsePolicy(text);

    expect(parsed.ok).toBe(true);
  });
});
