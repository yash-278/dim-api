import { delay } from 'es-toolkit';
import pg, { ClientBase } from 'pg';
import { metrics } from '../metrics/index.js';

// pools will use environment variables
// for connection information (from .env or a ConfigMap)
export const pool = new pg.Pool({
  max: 4,
  ...(process.env.PGSSL
    ? {
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
      }
    : {}),
  connectionTimeoutMillis: 5000,
  // Query timeout is on the NodeJS side, it times out the an operation on the client
  query_timeout: 2500,
});

pool.on('connect', () => {
  metrics.increment('db.pool.connect.count');
});
pool.on('acquire', () => {
  metrics.increment('db.pool.acquire.count');
});
pool.on('error', (e: Error) => {
  metrics.increment('db.pool.error.count');
  metrics.increment(`db.pool.error.${e.name}.count`);
});
pool.on('remove', () => {
  metrics.increment('db.pool.remove.count');
});

const metricsInterval = setInterval(() => {
  metrics.gauge('db.pool.total', pool.totalCount);
  metrics.gauge('db.pool.idle', pool.idleCount);
  metrics.gauge('db.pool.waiting', pool.waitingCount);
}, 10000);

export async function closeDbPool() {
  clearInterval(metricsInterval);
  return pool.end();
}

// A sleeping Postgres on Railway wakes when it receives a connection, which takes a few
// seconds. Keep retrying the connection for this long before failing the request.
const CONNECT_RETRY_WINDOW_MS = 30_000;

/**
 * Get a client from the pool, retrying while the database wakes up. Only connection
 * setup is retried; query errors are not.
 */
export async function connect(): Promise<pg.PoolClient> {
  const deadline = Date.now() + CONNECT_RETRY_WINDOW_MS;
  for (let retryDelay = 250; ; retryDelay = Math.min(retryDelay * 2, 4000)) {
    try {
      return await pool.connect();
    } catch (e) {
      if (Date.now() + retryDelay >= deadline) {
        throw e;
      }
      metrics.increment('db.pool.connect.retry.count');
      console.warn('Postgres connection failed, retrying', e instanceof Error ? e.message : e);
      await delay(retryDelay);
    }
  }
}

/**
 * Run a single query on a pooled client, retrying the connection while the database wakes up.
 */
export async function query<R extends pg.QueryResultRow>(
  config: pg.QueryConfig,
): Promise<pg.QueryResult<R>> {
  const client = await connect();
  try {
    return await client.query<R>(config);
  } finally {
    client.release();
  }
}

/**
 * A helper that gets a connection from the pool and then executes fn within a transaction.
 */
export async function transaction<T>(fn: (client: ClientBase) => Promise<T>) {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s';");

    const result = await fn(client);

    await client.query('COMMIT');

    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A helper that gets a connection from the pool and then executes fn within a transaction that's only meant for reads.
 */
export async function readTransaction<T>(fn: (client: ClientBase) => Promise<T>) {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s';");
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
