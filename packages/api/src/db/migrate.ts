import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";



const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

await migrate(db, { migrationsFolder });
console.log("✓ migrations applied");
await sql.end();
