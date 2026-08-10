import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export type DB = typeof db;

/** A real Drizzle transaction (the callback argument of `db.transaction`) — NOT the pooled
 *  `db`. APIs that must run on one dedicated connection/transaction (e.g. the operation lock's
 *  `withOperationLockInTx`) take THIS type so the pooled database is rejected at compile time:
 *  a session-scoped statement issued through the pool could land on a different connection
 *  than the one that follows it. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pooled database or a transaction — the ordinary executor for domain reads/writes. */
export type DbExecutor = typeof db | DbTransaction;
