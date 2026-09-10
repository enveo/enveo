import { lazy, useContext } from "react";
import { OpenImportActivity } from "../lib/shellContext";
import { LazyChunk } from "./lazy";

const Badge = lazy(() => import("./ImportActivityBadge").then((module) => ({ default: module.ImportActivityBadge })));

 
export function HeaderImportBadge() {
  const onOpen = useContext(OpenImportActivity);
  if (!onOpen) return null;
  return (
    <span data-header-import-badge style={{ position: "absolute", top: -5, right: -9, display: "flex" }}>
      <LazyChunk variant="silent">
        <Badge onOpen={onOpen} />
      </LazyChunk>
    </span>
  );
}
