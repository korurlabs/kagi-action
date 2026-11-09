/**
 * The main and post steps in-process, with the CLI replaced by a spawn stand-in. The forwarding
 * test runs the same steps with a real fake binary in a child process.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_BINARY, main, post, readInputs, reportFailure } from '../src/action.js';
import { ActionError } from '../src/core.js';
import { createHarness, fakeCliArchive, releaseFor, sha256, startServer, stubSpawn } from './helpers.js';

let server;
let harness;
afterEach(async () => {
  await server?.close();
  server = undefined;
  harness?.restore();
});

const BINDING_ID = '3fa2c1e0-0000-4000-8000-000000000000';

async function serveFakeCli() {
  const archive = fakeCliArchive();
  server = await startServer({ '/v9.9.9/kagi-cli_9.9.9_linux_amd64.tar.gz': { body: archive } });
  return { release: releaseFor('9.9.9', sha256(archive)), downloadBaseUrl: server.url };
}

function mainOptions(extra) {
  return {
    platform: 'linux',
    arch: 'x64',
    tempRoot: mkdtempSync(join(tmpdir(), 'kagi-action-main-')),
    ...extra,
  };
}

describe('inputs', () => {
  test('no input is required, and the defaults are the production API and a pull', () => {
    harness = createHarness();
    assert.deepEqual(readInputs(), {
      bindingId: '',
      apiUrl: 'https://api.kagi.pw',
      audience: '',
      version: '',
      pull: true,
    });
  });

  test('a binding-id that is not a UUID is refused', () => {
    harness = createHarness({ 'binding-id': 'my-binding' });
    assert.throws(() => readInputs(), /binding-id must be the binding's id \(a UUID\)/);
    harness.restore();
    harness = createHarness({ 'binding-id': `${BINDING_ID}; echo pwned` });
    assert.throws(() => readInputs(), ActionError);
  });

  test('api-url must be https, except for a server on the runner itself', () => {
    harness = createHarness({ 'api-url': 'http://kagi.example' });
    assert.throws(() => readInputs(), /api-url must use https/);
    for (const ok of ['https://kagi.example', 'http://127.0.0.1:8080', 'http://localhost:1', 'http://[::1]:9']) {
      process.env['INPUT_API-URL'] = ok;
      assert.equal(readInputs().apiUrl, ok);
    }
    process.env['INPUT_API-URL'] = 'not a url';
    assert.throws(() => readInputs(), /absolute URL/);
    process.env['INPUT_API-URL'] = 'file:///etc/passwd';
    assert.throws(() => readInputs(), /must use https/);
  });
});

describe('main step', () => {
  test('installs the verified CLI, saves it for the post step, puts it on PATH, then pulls', async () => {
    harness = createHarness({ 'binding-id': BINDING_ID, audience: 'kagi.example' });
    const spawn = stubSpawn();
    const options = mainOptions({ ...(await serveFakeCli()), spawnImpl: spawn.impl });

    await main(options);

    assert.equal(spawn.calls.length, 1);
    const [{ binary, args, options: spawnOptions }] = spawn.calls;
    assert.deepEqual(args, ['pull', '--github-env']);
    assert.equal(spawnOptions.env.KAGI_API_URL, 'https://api.kagi.pw');
    assert.equal(spawnOptions.env.KAGI_BINDING_ID, BINDING_ID);
    assert.equal(spawnOptions.env.KAGI_AUDIENCE, 'kagi.example');
    assert.ok(binary.startsWith(join(options.tempRoot, 'kagi-cli-')));
    assert.match(harness.stateWrites().join(''), new RegExp(`^${STATE_BINARY}<<ghadelimiter_[^\\n]+\\n${binary}\\n`));
    assert.equal(harness.pathWrites().join('').trim(), dirname(binary));
    assert.ok(harness.lines.some((line) => line.startsWith('Verified kagi-cli_9.9.9_linux_amd64.tar.gz')));
    assert.deepEqual(harness.errors(), []);
  });

  test('pull: false installs the CLI and runs nothing', async () => {
    harness = createHarness({ pull: 'false' });
    const spawn = stubSpawn();
    await main(mainOptions({ ...(await serveFakeCli()), spawnImpl: spawn.impl }));
    assert.equal(spawn.calls.length, 0);
    assert.equal(harness.stateWrites().length, 1, 'the post step still revokes after a kagi pull of a later step');
    assert.ok(harness.lines.some((line) => line.includes('kagi run -- <command>')));
  });

  test('a failing pull fails the step, after the state the post step needs was saved', async () => {
    harness = createHarness();
    const spawn = stubSpawn({ code: 1 });
    await assert.rejects(
      main(mainOptions({ ...(await serveFakeCli()), spawnImpl: spawn.impl })),
      /kagi pull --github-env exited with code 1/
    );
    assert.equal(harness.stateWrites().length, 1);
  });

  test('a version input without an embedded checksum is refused before any download', async () => {
    harness = createHarness({ version: '9.9.10' });
    const spawn = stubSpawn();
    await assert.rejects(
      main(mainOptions({ ...(await serveFakeCli()), spawnImpl: spawn.impl })),
      /Kagi CLI 9\.9\.10 has no SHA-256 embedded/
    );
    assert.deepEqual(server.requests, []);
    assert.equal(spawn.calls.length, 0);
    assert.equal(harness.stateWrites().length, 0);
  });

  test('a Windows runner is refused before any download', async () => {
    harness = createHarness();
    const spawn = stubSpawn();
    await assert.rejects(
      main(mainOptions({ ...(await serveFakeCli()), platform: 'win32', spawnImpl: spawn.impl })),
      /this job runs on Windows/
    );
    assert.deepEqual(server.requests, []);
  });

  test('a checksum mismatch installs nothing, saves no state and runs nothing', async () => {
    harness = createHarness();
    const spawn = stubSpawn();
    const served = await serveFakeCli();
    const options = mainOptions({ ...served, release: releaseFor('9.9.9', 'd'.repeat(64)), spawnImpl: spawn.impl });
    await assert.rejects(main(options), /does not match the SHA-256 this action pins/);
    assert.deepEqual(readdirSync(options.tempRoot), []);
    assert.equal(harness.stateWrites().length, 0);
    assert.equal(harness.pathWrites().length, 0);
    assert.equal(spawn.calls.length, 0);
  });

  test('the committed pin is what main installs by default', async () => {
    harness = createHarness({ version: '0.0.1' });
    // Refused against the real pin, which proves main reads src/cli-release.json.
    await assert.rejects(main({ platform: 'linux', arch: 'x64' }), /Kagi CLI 0\.0\.1 has no SHA-256 embedded/);
  });
});

describe('post step', () => {
  test('without an installed CLI there is nothing to revoke and nothing runs', async () => {
    harness = createHarness();
    const spawn = stubSpawn();
    await post({ spawnImpl: spawn.impl });
    assert.equal(spawn.calls.length, 0);
    assert.ok(harness.lines.some((line) => line.includes('minted no GitHub tokens to revoke')));
    assert.equal(process.exitCode, 0);
  });

  test('runs kagi ci revoke with the step environment', async () => {
    harness = createHarness();
    process.env.STATE_kagiBinary = '/tmp/kagi-cli-x/kagi';
    process.env.RUNNER_TEMP = '/tmp/runner';
    const spawn = stubSpawn();
    await post({ spawnImpl: spawn.impl });
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].binary, '/tmp/kagi-cli-x/kagi');
    assert.deepEqual(spawn.calls[0].args, ['ci', 'revoke']);
    assert.equal(spawn.calls[0].options.env.RUNNER_TEMP, '/tmp/runner');
  });

  test('follows the CLI: a non-zero exit fails the post step', async () => {
    harness = createHarness();
    process.env.STATE_kagiBinary = '/tmp/kagi-cli-x/kagi';
    await assert.rejects(post({ spawnImpl: stubSpawn({ code: 2 }).impl }), /kagi ci revoke exited with code 2/);
  });

  test('a CLI that cannot be started fails the post step', async () => {
    harness = createHarness();
    process.env.STATE_kagiBinary = '/tmp/kagi-cli-x/kagi';
    const error = Object.assign(new Error('spawn /tmp/kagi-cli-x/kagi ENOENT'), { code: 'ENOENT' });
    await assert.rejects(post({ spawnImpl: stubSpawn({ error }).impl }), /Could not start/);
  });
});

describe('reportFailure', () => {
  test('fails the step with the error message', () => {
    harness = createHarness();
    reportFailure(new ActionError('readable reason'));
    assert.deepEqual(harness.errors(), ['::error::readable reason']);
    assert.equal(process.exitCode, 1);
  });
});
