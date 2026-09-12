import type { ImportDirection, ImportProposal } from "./importRecognition";

export type ImportHistoryType = "expense" | "income" | "transfer";

/** A historical transaction mapped to stable, provider-neutral import facts. */
export interface ImportHistoryRecord {
  accountId: string;
  currency: string;
  sourceRef: string | null;
  tag: string | null;
  place: string | null;
  name: string | null;
  envelope: string | null;
  category: string | null;
  type: ImportHistoryType;
  isRefund: boolean;
  toAccountId: string | null;
}

type HistoryProposal = Pick<ImportProposal, "rawPlace" | "tag" | "currency" | "type" | "isRefund" | "semanticKind" | "toAccountId">;

/** Facts already validated from the visible import row, plus its selected source account. */
export interface ImportHistoryQuery {
  accountId: string;
  ownedAccountIds: readonly string[];
  proposal: HistoryProposal;
  /** Direction read from the screenshot, independent of the proposed classification. */
  direction?: ImportDirection;
}

export type ImportHistoryMatch = "exact_source_ref" | "contained_source_ref" | "merchant_identity" | "source_similarity" | "fuzzy_similarity";

/** Historical evidence only. Consumers must decide whether and how to enrich a proposal. */
export interface ImportHistoryCandidate {
  sourceRef: string | null;
  tag: string | null;
  place: string | null;
  name: string | null;
  envelope: string | null;
  category: string | null;
  type: ImportHistoryType;
  isRefund: boolean;
  toAccountId: string | null;
  count: number;
  match: ImportHistoryMatch;
}

export interface ImportHistorySelection {
  candidates: ImportHistoryCandidate[];
  conflict: boolean;
  /** Consensus over ALL strong patterns, before the prompt's display limit. Null means
   * disagreement; an absent field means history has no value to contribute. */
  metadata?: Partial<Record<"name" | "place" | "envelope" | "category", string | null>>;
}

const MIN_SIMILARITY = 0.3;
const MAX_CANDIDATES = 5;

/** Normalizes source text once before all equality and similarity comparisons. */
export function normalizeImportHistoryText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[Łł]/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const trigrams = (value: string): Set<string> => {
  const padded = `  ${value} `;
  const parts = new Set<string>();
  for (let index = 0; index < padded.length - 2; index++) parts.add(padded.slice(index, index + 3));
  return parts;
};

const similarity = (left: string, right: string): number => {
  if (left.length < 3 || right.length < 3) return 0;
  if (left.includes(right) || right.includes(left)) return 0.95;
  const leftParts = trigrams(left);
  const rightParts = trigrams(right);
  let intersection = 0;
  for (const part of leftParts) if (rightParts.has(part)) intersection++;
  return (2 * intersection) / (leftParts.size + rightParts.size);
};

const sameCurrency = (left: string | null, right: string): boolean => left?.trim().toUpperCase() === right.trim().toUpperCase();

const compatibleWithVisibleFacts = (query: ImportHistoryQuery, record: ImportHistoryRecord): boolean => {
  const { proposal } = query;
  if (record.accountId !== query.accountId || !sameCurrency(proposal.currency, record.currency)) return false;

  if (proposal.semanticKind === "internal_transfer") {
    return (
      record.type === "transfer" && record.toAccountId !== null && record.toAccountId !== query.accountId && query.ownedAccountIds.includes(record.toAccountId)
    );
  }

  if (record.type === "transfer") return false;
  if (query.direction !== undefined) {
    const direction = record.type === "income" || record.isRefund ? "credit" : "debit";
    if (query.direction !== "unknown" && direction !== query.direction) return false;
    // An unknown sign cannot veto historical counterevidence. The caller flags it for review.
    return true;
  }
  if (record.type !== proposal.type) return false;
  return record.type !== "expense" || record.isRefund === proposal.isRefund;
};

const merchantIdentity = (proposal: HistoryProposal, record: ImportHistoryRecord): boolean => {
  const tag = normalizeImportHistoryText(proposal.tag);
  const lines = proposal.rawPlace.split("\n").map(normalizeImportHistoryText);
  return [record.tag, record.place].some((value) => {
    const identity = normalizeImportHistoryText(value);
    return /\p{L}{3}/u.test(identity) && (identity === tag || lines.includes(identity));
  });
};

type CandidateValue = string | boolean | null;

const serializeCandidateTuple = (values: readonly CandidateValue[]): string => JSON.stringify(values);

const assignmentKey = (candidate: ImportHistoryCandidate): string =>
  serializeCandidateTuple([candidate.place, candidate.name, candidate.envelope, candidate.category, candidate.type, candidate.isRefund, candidate.toAccountId]);

const evidenceKey = (candidate: ImportHistoryCandidate): string =>
  serializeCandidateTuple([
    candidate.sourceRef,
    candidate.tag,
    candidate.place,
    candidate.name,
    candidate.envelope,
    candidate.category,
    candidate.type,
    candidate.isRefund,
    candidate.toAccountId,
  ]);

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const matchRank = (match: ImportHistoryMatch): number => {
  switch (match) {
    case "exact_source_ref":
      return 4;
    case "contained_source_ref":
    case "merchant_identity":
      return 3;
    case "source_similarity":
      return 2;
    case "fuzzy_similarity":
      return 1;
  }
};

const sourceHasMerchant = (source: string, record: Pick<ImportHistoryRecord, "tag" | "place">): boolean =>
  [record.tag, record.place].some((value) => {
    const identity = normalizeImportHistoryText(value);
    return /\p{L}{3}/u.test(identity) && ` ${source} `.includes(` ${identity} `);
  });

/**
 * Retrieves compatible historical assignment patterns as evidence. It never
 * treats a text match as certain and never changes the visible proposal facts.
 */
export function selectImportHistoryCandidates(query: ImportHistoryQuery, records: readonly ImportHistoryRecord[], limit = 5): ImportHistorySelection {
  const raw = normalizeImportHistoryText(query.proposal.rawPlace);
  const lines = query.proposal.rawPlace.split("\n").map(normalizeImportHistoryText);
  const grouped = new Map<string, { candidate: ImportHistoryCandidate; rank: number; score: number }>();

  records.forEach((record) => {
    if (!compatibleWithVisibleFacts(query, record)) return;

    const source = normalizeImportHistoryText(record.sourceRef);
    const exactSource = raw !== "" && raw === source;
    const exactMerchant = merchantIdentity(query.proposal, record);
    // Match a complete descriptor line, never a merchant prefix or a shared card number.
    const containedSource = source !== "" && lines.includes(source) && sourceHasMerchant(source, record);
    const sourceScore = source ? similarity(raw, source) : 0;
    const fuzzyScore = Math.max(
      similarity(raw, normalizeImportHistoryText(record.place)),
      similarity(raw, normalizeImportHistoryText(record.tag)),
      similarity(raw, normalizeImportHistoryText(record.name)),
    );
    const match: ImportHistoryMatch | null = exactSource
      ? "exact_source_ref"
      : containedSource
        ? "contained_source_ref"
        : exactMerchant
          ? "merchant_identity"
          : sourceScore >= MIN_SIMILARITY
            ? "source_similarity"
            : fuzzyScore >= MIN_SIMILARITY
              ? "fuzzy_similarity"
              : null;
    if (!match) return;

    const candidate: ImportHistoryCandidate = {
      sourceRef: record.sourceRef,
      tag: record.tag,
      place: record.place,
      name: record.name,
      envelope: record.envelope,
      category: record.category,
      type: record.type,
      isRefund: record.isRefund,
      toAccountId: record.type === "transfer" ? record.toAccountId : null,
      count: 1,
      match,
    };
    const key = assignmentKey(candidate);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { candidate, rank: matchRank(match), score: Math.max(sourceScore, fuzzyScore) });
      return;
    }
    existing.candidate.count++;
    const rank = matchRank(match);
    const score = Math.max(sourceScore, fuzzyScore);
    if (
      rank > existing.rank ||
      (rank === existing.rank &&
        (score > existing.score || (score === existing.score && compareText(evidenceKey(candidate), evidenceKey(existing.candidate)) < 0)))
    ) {
      const count = existing.candidate.count;
      existing.candidate = candidate;
      existing.candidate.count = count;
      existing.rank = rank;
      existing.score = score;
    }
  });

  const ranked = [...grouped.values()].sort(
    (left, right) =>
      right.rank - left.rank ||
      right.score - left.score ||
      right.candidate.count - left.candidate.count ||
      compareText(assignmentKey(left.candidate), assignmentKey(right.candidate)),
  );
  const displayLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), MAX_CANDIDATES)) : MAX_CANDIDATES;
  // Keep every merchant-backed pattern: a full-row match cannot hide a conflicting
  // descriptor-only match. Only incidental similarity evidence is discarded.
  const strongEntries = ranked.filter(
    ({ candidate }) =>
      candidate.match === "merchant_identity" ||
      candidate.match === "contained_source_ref" ||
      (candidate.match === "exact_source_ref" && sourceHasMerchant(normalizeImportHistoryText(candidate.sourceRef), candidate)),
  );
  const strongest = strongEntries.length > 0 ? strongEntries : ranked;
  const candidates = strongest.map((entry) => entry.candidate);
  const moneyConflict = candidates.some(
    (candidate) =>
      candidate.type !== query.proposal.type || candidate.isRefund !== query.proposal.isRefund || candidate.toAccountId !== query.proposal.toAccountId,
  );
  const strong = strongEntries.length > 0;
  const metadata: NonNullable<ImportHistorySelection["metadata"]> = {};
  if (strong && !moneyConflict) {
    for (const field of ["name", "place", "envelope", "category"] as const) {
      const values = [...new Set(candidates.map((candidate) => candidate[field]?.trim() || null))];
      if (values.length === 1 && values[0] !== null) metadata[field] = values[0];
      else if (values.length > 1 && field !== "name") metadata[field] = null;
    }
  }
  const assignmentConflict = strong
    ? ["place", "envelope", "category"].some(
        (field) => new Set(candidates.map((candidate) => candidate[field as "place" | "envelope" | "category"]?.trim() || null)).size > 1,
      )
    : candidates.length > 1;
  return {
    candidates: candidates.slice(0, displayLimit),
    conflict: assignmentConflict || (query.proposal.type !== null && moneyConflict),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
