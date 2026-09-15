import { createContext, useContext } from "react";
import type { ViewMode } from "./viewMode";

export type PaneRect = { left: number; width: number };

export type PaneSurfaceHost = {
  node: HTMLElement | null;

  register: (s: { close: () => void }) => () => void;
};

export type WideHostInfo = {
  host: "primary" | "panel";
  mode: Exclude<ViewMode, "phone">;

  rects: { primary: PaneRect; panel: PaneRect | null };

  surfaces?: PaneSurfaceHost;
};

export const InWideShell = createContext<WideHostInfo | null>(null);

export function useWideHost(): WideHostInfo | null {
  return useContext(InWideShell);
}

export const OpenImportActivity = createContext<(() => void) | null>(null);
