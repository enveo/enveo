/**
 * State of the collapsible ⓘ "how to read" notes on the Reports screen.
 *
 * Per DEVICE (localStorage `enveo.reportNotes`, outside sync) — a map of
 * report id → dismissed. Corrupted/foreign JSON is treated as an empty map,
 * missing localStorage (tests/private mode) never throws.
 */

const KEY = "enveo.reportNotes";

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Whether the given report's note was collapsed by the user. */
export function isNoteDismissed(id: string): boolean {
  return readMap()[id] === true;
}

/** Save the note state (true = collapsed to a chip, false = expanded). */
export function setNoteDismissed(id: string, v: boolean): void {
  try {
    const m = readMap();
    if (v) m[id] = true;
    else delete m[id];
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* localStorage unavailable — the state simply won't survive a reload */
  }
}
