import { afterEach, describe, expect, it } from "bun:test";
import { assertDbEnv, resolveDatabaseUrl } from "./env";

const KEYS = ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASS", "DB_NAME", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function clearAll() {
  for (const k of KEYS) delete process.env[k];
}

describe("resolveDatabaseUrl", () => {
  it("DATABASE_URL wins over everything", () => {
    clearAll();
    process.env.DATABASE_URL = "postgres://a:b@x:1/z";
    process.env.DB_HOST = "ignored";
    expect(resolveDatabaseUrl()).toBe("postgres://a:b@x:1/z");
  });
  it("composes from DB_* (PikaPods injection model), URL-escaping credentials", () => {
    clearAll();
    process.env.DB_HOST = "pg.internal";
    process.env.DB_PORT = "5433";
    process.env.DB_USER = "enveo";
    process.env.DB_PASS = "p@ss/w:rd";
    process.env.DB_NAME = "enveodb";
    expect(resolveDatabaseUrl()).toBe("postgres://enveo:p%40ss%2Fw%3Ard@pg.internal:5433/enveodb");
  });
  it("DB_* defaults: port 5432, db name falls back to the user", () => {
    clearAll();
    process.env.DB_HOST = "h";
    process.env.DB_USER = "u";
    expect(resolveDatabaseUrl()).toBe("postgres://u@h:5432/u");
  });
  it("nothing set → dev fallback", () => {
    clearAll();
    expect(resolveDatabaseUrl()).toBe("postgres://enveo:enveo@localhost:5432/enveo");
  });
});

describe("assertDbEnv", () => {
  it("production without any DB config aborts the boot", () => {
    clearAll();
    process.env.NODE_ENV = "production";
    expect(() => assertDbEnv()).toThrow(/DATABASE_URL/);
  });
  it("production with DATABASE_URL or DB_HOST passes; dev always passes", () => {
    clearAll();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://a@b/c";
    expect(() => assertDbEnv()).not.toThrow();
    clearAll();
    process.env.NODE_ENV = "production";
    process.env.DB_HOST = "h";
    expect(() => assertDbEnv()).not.toThrow();
    clearAll();
    expect(() => assertDbEnv()).not.toThrow();
  });
});
