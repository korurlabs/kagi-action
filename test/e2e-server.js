/**
 * A stand-in for the GitHub OIDC token service and the Kagi API, used by the CI smoke test.
 *
 * The smoke test runs the real action on a real runner: the real CLI download and checksum check,
 * the real Kagi CLI in CI mode, the real $GITHUB_ENV and the post step. The job deliberately does
 * NOT declare `permissions: id-token: write`, so the only ACTIONS_ID_TOKEN_REQUEST_* variables in
 * play are the ones the workflow points at this server.
 *
 * Serves the routes the Kagi CLI calls in CI mode:
 *   GET  /token?api-version=2.0&audience=...  -> { value: "<unsigned JWT>" }
 *   POST /kagi/auth/ci/exchange               -> KagiCiTokenExchangeResponse, or a 401 Problem
 *   GET  /kagi/ci/secrets                     -> KagiCiSecretsResponse, once per Kagi token
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// The CLI asks for an id-token whose audience is the host of the Kagi API it talks to, and this
// server is that API, so a job that sets no audience must ask for 127.0.0.1.
const EXPECTED_AUDIENCE = process.env.E2E_EXPECTED_AUDIENCE ?? '127.0.0.1';
const RUNNER_BEARER = 'e2e-runner-bearer';
const SECRET_VALUE = 'e2e-secret-value';
const BINDING_NAME = 'e2e-binding';
/** The binding id the smoke test sends to get the opaque 401 of a refused job. */
const DENIED_BINDING_ID = '00000000-0000-4000-8000-000000000000';

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Unsigned, but shaped like GitHub's, so the CLI can print the job's claims on a refusal. */
const ID_TOKEN = [
  base64url({ alg: 'none', typ: 'JWT' }),
  base64url({
    aud: EXPECTED_AUDIENCE,
    repository: 'korurlabs/kagi-action',
    workflow_ref: 'korurlabs/kagi-action/.github/workflows/ci.yml@refs/heads/main',
    ref: 'refs/heads/main',
    event_name: 'push',
  }),
  'e2e-signature',
].join('.');

/** Kagi tokens issued by the exchange and not yet spent by a read. */
const unspentTokens = new Set();

function json(response, status, payload, contentType = 'application/json') {
  response.writeHead(status, { 'content-type': contentType });
  response.end(JSON.stringify(payload));
}

function refuse(response, detail) {
  json(
    response,
    401,
    { type: 'about:blank', title: 'Unauthorized', status: 401, detail, code: 'KGI_AUT_002' },
    'application/problem+json'
  );
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/token') {
    if (request.headers.authorization !== `Bearer ${RUNNER_BEARER}`) {
      return json(response, 401, { message: 'wrong runner bearer' });
    }
    if (url.searchParams.get('audience') !== EXPECTED_AUDIENCE) {
      return json(response, 400, { message: `wrong audience: ${url.searchParams.get('audience')}` });
    }
    return json(response, 200, { value: ID_TOKEN });
  }

  if (request.method === 'POST' && url.pathname === '/kagi/auth/ci/exchange') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(response, 400, { message: `not JSON: ${error.message}` });
    }
    if (body.bindingId === DENIED_BINDING_ID) {
      return refuse(response, 'No Kagi CI binding accepts this job.');
    }
    if (body.provider !== 'GITHUB_ACTIONS' || body.token !== ID_TOKEN) {
      return refuse(response, 'The id-token was not accepted.');
    }
    const accessToken = `e2e-kagi-token-${randomUUID()}`;
    unspentTokens.add(accessToken);
    return json(response, 200, {
      accessToken,
      bindingName: BINDING_NAME,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
  }

  if (request.method === 'GET' && url.pathname === '/kagi/ci/secrets') {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    // Spent by its first read, as the real token is.
    if (!unspentTokens.delete(token)) {
      return refuse(response, 'The Kagi token is unknown or already used.');
    }
    return json(response, 200, {
      bindingName: BINDING_NAME,
      dotenv: null,
      githubTokens: [],
      recentlyRemoved: ['E2E_REMOVED'],
      secrets: { E2E_SECRET: SECRET_VALUE, E2E_MULTILINE: 'first-line\nsecond-line' },
    });
  }

  return json(response, 404, { message: 'no route' });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // The workflow reads these back to build the step env; writing them out avoids parsing logs.
  writeFileSync(
    process.env.E2E_ENDPOINT_FILE ?? 'e2e-endpoints.env',
    `E2E_TOKEN_URL=${base}/token?api-version=2.0\nE2E_API_URL=${base}\nE2E_SECRET_VALUE=${SECRET_VALUE}\n`
  );
  process.stdout.write(`e2e server listening on ${base}\n`);
});
