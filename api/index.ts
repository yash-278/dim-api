import { createTerminus } from '@godaddy/terminus';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import express from 'express';
import http from 'http';
import morgan from 'morgan';
import { refreshApps, stopAppsRefresh } from './apps/index.js';
import { closeDbPool } from './db/index.js';
import { app as dimGgApp } from './dim-gg/server.js';
import { metrics } from './metrics/index.js';
import { app as dimApiApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

metrics.increment('startup.count', 1);

const app = express();

app.set('trust proxy', true); // enable x-forwarded-for
app.set('x-powered-by', false);

// The request handler must be the first middleware on the app
app.use(
  Sentry.Handlers.requestHandler({
    user: ['bungieMembershipId'],
  }),
);
// TracingHandler creates a trace for every incoming request
app.use(Sentry.Handlers.tracingHandler());
// The error handler must be before any other error middleware
app.use(Sentry.Handlers.errorHandler());
app.use(morgan('combined')); // logging

const shortlinkHost = process.env.SHORTLINK_HOST;
if (shortlinkHost) {
  app.use((req, res, next) => {
    if (req.hostname === shortlinkHost) {
      dimGgApp(req, res, next);
    } else {
      next();
    }
  });
}

// The generated Railway hostname and API custom hostname both use the API app.
app.use(dimApiApp);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.COMMITHASH,
    integrations: [
      // enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // enable Express.js middleware tracing
      new Tracing.Integrations.Express({
        // to trace all requests to the default router
        app,
        // alternatively, you can specify the routes you want to trace:
        // router: someRouter,
      }),
      new Tracing.Integrations.Postgres(),
    ],
    tracesSampleRate: 0.001,
    maxValueLength: 10_000,
  });
}

const server = http.createServer(app);

function beforeShutdown() {
  const shutdownTime = process.env.NODE_ENV === 'production' ? 10000 : 100;
  console.log('Wait', shutdownTime, 'ms before shutdown');
  // allow readiness probes to notice things are down
  return new Promise((resolve) => {
    setTimeout(resolve, shutdownTime);
  });
}

async function healthCheck() {
  return;
}
createTerminus(server, {
  healthChecks: {
    '/healthcheck': healthCheck,
  },
  beforeShutdown,
  onShutdown: async () => {
    console.log('Shutting down');
    stopAppsRefresh();
    closeDbPool();
  },
});

refreshApps()
  .then(() => {
    server.listen(port, () => console.log(`DIM API started up on port ${port}`));
  })
  .catch((e) => {
    console.log('Unable to load apps', e);
    throw e;
  });
