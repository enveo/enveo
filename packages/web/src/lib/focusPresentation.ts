export const INPUT_FOCUS_CLASS = "input-focus-shell";

export const INPUT_FOCUS_CSS = `@supports selector(:has(*)){.${INPUT_FOCUS_CLASS}>input:focus-visible{outline:none}.${INPUT_FOCUS_CLASS}:has(>input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}[data-band] .${INPUT_FOCUS_CLASS}:has(>input:focus-visible){outline-color:var(--focus-ring-band)}}`;

export function activeAllocationDecoration(color: string): { borderRadius: 7; boxShadow: string } {
  return { borderRadius: 7, boxShadow: `inset 0 -2px 0 ${color}` };
}
