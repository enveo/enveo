import { migrate } from "drizzle-orm/postgres-js/migrator";
import { assertDbEnv } from "../env";
import { db, sql } from "./client";



assertDbEnv();



const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

await migrate(db, { migrationsFolder });
console.log("✓ migrations applied");
await sql.end();
