// lib/shellContext.ts — the ONLY shared module between eager screens and the lazy shell.
// Keep it dependency-free: anything imported here lands in the phone bundle.
import { createContext } from "react";

/** True when the screen renders inside the wide shell's primary pane (band header owns
 *  month nav + title; the screen must not render its own `Header`). Default false = phone. */
export const InWideShell = createContext(false);
