import { createBinanceBetaHandler } from './handler.mjs';
import { createBinanceBetaInternalHandler } from './internal-handler.mjs';
import { createRuntimeDependencies, readRuntimeConfig } from './runtime.mjs';

const INTERNAL_ROUTES = [
  '/internal/v1/sync/cron',
  '/internal/v1/archive/cron',
  '/binance-beta/internal/v1/sync/cron',
  '/binance-beta/internal/v1/archive/cron',
];

function isInternalRoute(path: string): boolean {
  return INTERNAL_ROUTES.some((route) => path === route
    || (route.startsWith('/binance-beta/') && path.endsWith(route)));
}

function unavailable(): Response {
  return new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

const config = readRuntimeConfig((name) => Deno.env.get(name));
if (!config) {
  Deno.serve(unavailable);
} else {
  const dependencies = createRuntimeDependencies(config);
  const publicHandler = createBinanceBetaHandler(dependencies.publicDeps);
  const internalHandler = createBinanceBetaInternalHandler(dependencies.internalDeps);
  Deno.serve((request: Request) => {
    const path = new URL(request.url).pathname;
    return isInternalRoute(path) ? internalHandler(request) : publicHandler(request);
  });
}
