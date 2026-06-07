import { logger } from './logger';

const WORKER_URL = (process.env.WORKER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

let _catalog: string | null = null;
let _cachedAt = 0;

/**
 * Returns the node catalog text, fetching it from the worker if the local
 * cache is stale or empty.  Throws if the worker is unreachable on first load.
 */
export async function getNodeCatalog(): Promise<string> {
  if (_catalog && Date.now() - _cachedAt < CACHE_TTL_MS) return _catalog;

  logger.info('[catalog] Fetching node catalog from worker…');
  const res = await fetch(`${WORKER_URL}/api/nodes/catalog`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Worker catalog endpoint returned ${res.status}`);

  const body = await res.json() as { catalog: string };
  _catalog = body.catalog;
  _cachedAt = Date.now();
  logger.info(`[catalog] Cached (${_catalog.length} chars)`);
  return _catalog;
}

/** Pre-warm the catalog at startup so the first request doesn't pay the fetch cost. */
export async function warmCatalog(): Promise<void> {
  try {
    await getNodeCatalog();
  } catch (err) {
    logger.warn('[catalog] Pre-warm failed (worker not ready yet?):', err);
  }
}
