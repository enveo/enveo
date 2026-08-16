import type { ImportProposal } from "./importRecognition";

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
}

export type ImportHistoryMatch = "exact_source_ref" | "merchant_identity" | "source_similarity" | "fuzzy_similarity";

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
  if (record.accountId !== query.accountId || !sameCurrency(proposal.currency, record.currency) || proposal.type === null) return false;

  if (proposal.semanticKind === "internal_transfer") {
    return (
      record.type === "transfer" && record.toAccountId !== null && record.toAccountId !== query.accountId && query.ownedAccountIds.includes(record.toAccountId)
    );
  }

  if (record.type !== proposal.type || record.type === "transfer") return false;
  return record.type !== "expense" || record.isRefund === proposal.isRefund;
};

const merchantIdentity = (proposal: HistoryProposal, record: ImportHistoryRecord): boolean => {
  const tag = normalizeImportHistoryText(proposal.tag);
  if (!tag) return false;
  return [record.tag, record.place].some((value) => normalizeImportHistoryText(value) === tag);
};

const assignmentKey = (candidate: ImportHistoryCandidate): string =>
  [candidate.place, candidate.name, candidate.envelope, candidate.category, candidate.type, candidate.isRefund, candidate.toAccountId]
    .map((value) => String(value ?? ""))
    .join("\u0000");

const evidenceKey = (candidate: ImportHistoryCandidate): string =>
  [
    candidate.sourceRef,
    candidate.tag,
    candidate.place,
    candidate.name,
    candidate.envelope,
    candidate.category,
    candidate.type,
    candidate.isRefund,
    candidate.toAccountId,
  ]
    .map((value) => String(value ?? ""))
    .join("\u0000");

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const matchRank = (match: ImportHistoryMatch): number => {
  switch (match) {
    case "exact_source_ref":
      return 4;
    case "merchant_identity":
      return 3;
    case "source_similarity":
      return 2;
    case "fuzzy_similarity":
      return 1;
  }
};

/**
 * Retrieves compatible historical assignment patterns as evidence. It never
 * treats a text match as certain and never changes the visible proposal facts.
 */
export function selectImportHistoryCandidates(query: ImportHistoryQuery, records: readonly ImportHistoryRecord[], limit = 5): ImportHistorySelection {
  const raw = normalizeImportHistoryText(query.proposal.rawPlace);
  const grouped = new Map<string, { candidate: ImportHistoryCandidate; rank: number; score: number }>();

  records.forEach((record) => {
    if (!compatibleWithVisibleFacts(query, record)) return;

    const source = normalizeImportHistoryText(record.sourceRef);
    const exactSource = raw !== "" && raw === source;
    const exactMerchant = merchantIdentity(query.proposal, record);
    const sourceScore = source ? similarity(raw, source) : 0;
    const fuzzyScore = Math.max(
      similarity(raw, normalizeImportHistoryText(record.place)),
      similarity(raw, normalizeImportHistoryText(record.tag)),
      similarity(raw, normalizeImportHistoryText(record.name)),
    );
    const match: ImportHistoryMatch | null = exactSource
      ? "exact_source_ref"
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
  return {
    candidates: ranked.slice(0, displayLimit).map(({ candidate }) => candidate),
    conflict: ranked.length > 1,
  };
}
