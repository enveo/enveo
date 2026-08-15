export const INPUT_FOCUS_CLASS = "input-focus-shell";
export const NAME_UNDERLINE_FOCUS_CLASS = "name-underline-focus";

export const INPUT_FOCUS_CSS = `@supports selector(:has(*)){.${INPUT_FOCUS_CLASS}>input:focus-visible{outline:none}.${INPUT_FOCUS_CLASS}:has(>input:focus-visible){outline:2px solid var(--input-underline);outline-offset:2px}}`;
export const NAME_UNDERLINE_FOCUS_CSS = `.${NAME_UNDERLINE_FOCUS_CLASS}:focus-visible{outline:none;box-shadow:inset 0 -2px 0 var(--input-underline)}`;

export function activeAllocationDecoration(color: string): { borderRadius: 7; boxShadow: string } {
  return { borderRadius: 7, boxShadow: `inset 0 -2px 0 ${color}` };
}
