import { Pool } from "pg";

const globalForDatabase = globalThis as typeof globalThis & {
  worldrawingDatabasePool?: Pool;
};

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();

  if (!value) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return value;
}

export function databasePool(): Pool {
  if (!globalForDatabase.worldrawingDatabasePool) {
    const pool = new Pool({
      connectionString: databaseUrl(),
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error);
    });

    globalForDatabase.worldrawingDatabasePool = pool;
  }

  return globalForDatabase.worldrawingDatabasePool;
}
