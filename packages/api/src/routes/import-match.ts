/** Model proposal from cycle-two enrichment, before resolving names to ids. */
export interface ModelAssignment {
  name: string | null;
  place: string | null;
  envelope: string | null;
  category: string | null;
}

export function decideAssignment(
  rawPlace: string,
  model: ModelAssignment | undefined,
): { name: string; place: string | null; envelope: string | null; category: string | null } {
  return {
    name: model?.name?.trim() || rawPlace,
    place: model?.place?.trim() || null,
    envelope: model?.envelope?.trim() || null,
    category: model?.category?.trim() || null,
  };
}
