import * as Sentry from '@sentry/node';
import { keyBy } from 'es-toolkit';
import { RequestHandler } from 'express';
import { getAllApps as getAllAppsPostgres } from '../db/apps-queries.js';
import { readTransaction } from '../db/index.js';
import { metrics } from '../metrics/index.js';
import { ApiApp } from '../shapes/app.js';

const checkApiKey: RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/heathcheck') {
    next();
    return;
  }
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    metrics.increment('apiKey.missing.count');
    res.status(401).send({
      error: 'MissingApiKey',
      message: 'This request requires the X-API-Key header to be set',
    });
    return;
  }

  const app = getAppByApiKey(apiKey);
  if (app) {
    req.dimApp = app;
    next();
  } else {
    metrics.increment('apiKey.noAppFound.count');
    res.status(401).send({
      error: 'NoAppFound',
      message: 'No app found that matches the provided API key',
    });
  }
};

/**
 * Express middleware that requires an API key be provided in a header
 * and populates app info in the request based on the matching app.
 */
export const apiKey: RequestHandler = (req, res, next) => {
  ensureApps().then(() => checkApiKey(req, res, next), next);
};

// Reload the app list at most this often. Reloads happen on incoming requests rather
// than on a timer, so an idle server sends no traffic to Postgres and both can sleep.
const APPS_MAX_AGE_MS = 60_000;

let apps: ApiApp[] = [];
let appsByApiKey: { [apiKey: string]: ApiApp } = {};
let origins = new Set<string>();
let appsLoadedAt = 0;
let appsRefresh: Promise<void> | undefined;

/**
 * Look up an app by its API key.
 */
function getAppByApiKey(apiKey: string) {
  const app = appsByApiKey[apiKey.toLowerCase()];
  if (!app) {
    console.error('No app found: ', apps, apiKey);
  }
  return app;
}

export function isAppOrigin(origin: string) {
  return origins.has(origin);
}

/**
 * Load the app list before the first request. After that, serve the cached list and
 * reload it in the background once it is older than APPS_MAX_AGE_MS.
 */
function ensureApps(): Promise<void> {
  if (!appsLoadedAt) {
    return refreshApps();
  }
  if (Date.now() - appsLoadedAt > APPS_MAX_AGE_MS) {
    // refreshApps already logs and reports failures; keep serving the cached list.
    refreshApps().catch(() => undefined);
  }
  return Promise.resolve();
}

/** Reload the app list from Postgres. Concurrent callers share one query. */
export function refreshApps(): Promise<void> {
  appsRefresh ??= loadApps().finally(() => {
    appsRefresh = undefined;
  });
  return appsRefresh;
}

async function loadApps(): Promise<void> {
  try {
    apps = await readTransaction((client) => getAllAppsPostgres(client));
    digestApps();
    appsLoadedAt = Date.now();
    metrics.increment('apps.refresh.success.count');
  } catch (e) {
    metrics.increment('apps.refresh.error.count');
    console.error('Error refreshing apps', e);
    Sentry.captureException(e);
    throw e;
  }
}

function digestApps() {
  appsByApiKey = keyBy(apps, (a) => a.dimApiKey.toLowerCase());
  origins = new Set<string>();
  for (const app of apps) {
    origins.add(app.origin);
  }
}
