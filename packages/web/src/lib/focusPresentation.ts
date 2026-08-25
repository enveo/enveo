export const INPUT_FOCUS_CLASS = "input-focus-shell";
export const NAME_UNDERLINE_FOCUS_CLASS = "name-underline-focus";

export const INPUT_FOCUS_CSS = `@supports selector(:has(*)){.${INPUT_FOCUS_CLASS}>input:focus-visible{outline:none}.${INPUT_FOCUS_CLASS}:has(>input:focus-visible){outline:2px solid var(--input-underline);outline-offset:2px}}`;
export const NAME_UNDERLINE_FOCUS_CSS = `.${NAME_UNDERLINE_FOCUS_CLASS}:focus-visible{outline:none;box-shadow:inset 0 -2px 0 var(--input-underline)}`;

export function activeAllocationDecoration(color: string): { borderRadius: 7; boxShadow: string } {
  return { borderRadius: 7, boxShadow: `inset 0 -2px 0 ${color}` };
}

/** Native checkboxes render as hard-cornered platform widgets that ignore `border-radius`, which
 *  read as unstyled next to this app's rounded inputs, cards and buttons (reported on the Login
 *  "private device" checkbox). `appearance:none` hands us the box, so it can take the same 5px
 *  radius the rest of the UI uses; the checkmark is a clip-path wedge scaled in on `:checked`,
 *  which needs no icon font and no extra element. Applied globally, not per call site, so all
 *  five checkboxes in the app stay identical. A caller's inline `width`/`height` still wins
 *  (E2eeUpgradePanel asks for 18px), and `accentColor` becomes a no-op once appearance is none —
 *  the checked fill comes from `--accent` here instead. */
export const CHECKBOX_CSS =
  `input[type=checkbox]{appearance:none;-webkit-appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;` +
  `border:1.5px solid var(--line);border-radius:5px;background:var(--card);display:inline-grid;place-content:center;cursor:pointer}` +
  `input[type=checkbox]::before{content:"";width:10px;height:10px;transform:scale(0);transition:transform .12s ease-out;` +
  `background:#fff;clip-path:polygon(14% 44%,0 60%,39% 100%,100% 18%,84% 0,39% 68%)}` +
  `input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}` +
  `input[type=checkbox]:checked::before{transform:scale(1)}` +
  `input[type=checkbox]:disabled{cursor:default;opacity:.5}`;
