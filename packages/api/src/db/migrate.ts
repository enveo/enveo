import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";

// Path independent of cwd (in the container cwd=/app, locally cwd=packages/api).
// migrate.ts: packages/api/src/db/ → migrations in packages/api/drizzle (../../drizzle).
const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

await migrate(db, { migrationsFolder });
console.log("✓ migrations applied");
await sql.end();
