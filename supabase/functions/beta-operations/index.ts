import { createRemoteJWKSet, jwtVerify } from 'npm:jose@6.1.2';

import { createBetaOperationsHandler } from './handler.mjs';
import { createRuntimeDependencies, readRuntimeConfig } from './runtime.mjs';

const GITHUB_JWKS = createRemoteJWKSet(
  new URL('https://token.actions.githubusercontent.com/.well-known/jwks'),
  {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  },
);

function unavailable(): Response {
  return new Response(JSON.stringify({ error: 'operation_unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const config = readRuntimeConfig((name: string) => Deno.env.get(name));

if (!config) {
  Deno.serve(unavailable);
} else {
  const dependencies = createRuntimeDependencies(config, {
    async verifyGithubOidc(
      token: string,
      verification: { issuer: string; audience: string; algorithms: string[] },
    ) {
      const { payload } = await jwtVerify(token, GITHUB_JWKS, {
        issuer: verification.issuer,
        audience: verification.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      return payload;
    },
  });
  const handler = createBetaOperationsHandler(dependencies);
  Deno.serve((request: Request) => handler(request));
}
