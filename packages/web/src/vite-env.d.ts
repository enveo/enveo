/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_INFO__: { time: string; sha: string };

declare module "sql.js" {
  interface Statement {
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }
  class Database {
    constructor(data: Uint8Array);
    prepare(sql: string): Statement;
    close(): void;
  }
  export default function initSqlJs(config: { locateFile: (file: string) => string; wasmBinary?: ArrayBuffer }): Promise<{ Database: typeof Database }>;
}
