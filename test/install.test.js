import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, installCli, verifySha256 } from '../src/install.js';
import { ActionError } from '../src/core.js';
import { createHarness, fakeCliArchive, FAKE_KAGI_SCRIPT, sha256, startServer, tarArchive } from './helpers.js';
import { gzipSync } from 'node:zlib';

let server;
let harness;
afterEach(async () => {
  await server?.close();
  server = undefined;
  harness?.restore();
});

const ASSET = 'kagi-cli_9.9.9_linux_amd64.tar.gz';
const noWait = async () => {};

function resolvedFor(url, sha) {
  return { version: '9.9.9', assetName: ASSET, url, sha256: sha };
}

describe('checksum', () => {
  test('a matching SHA-256 passes', () => {
    const archive = fakeCliArchive();
    verifySha256(archive, sha256(archive), ASSET);
  });

  test('a mismatch is refused and says nothing was extracted or run', () => {
    assert.throws(
      () => verifySha256(Buffer.from('tampered'), 'b'.repeat(64), ASSET),
      (error) =>
        error instanceof ActionError &&
        error.message.includes(`${ASSET} does not match the SHA-256 this action pins`) &&
        error.message.includes(`expected ${'b'.repeat(64)}`) &&
        error.message.includes('Nothing from it was extracted or run')
    );
  });
});

describe('installCli', () => {
  test('downloads, verifies and installs an executable kagi', async () => {
    harness = createHarness();
    const archive = fakeCliArchive();
    server = await startServer({ [`/${ASSET}`]: { body: archive } });
    const tempRoot = mkdtempSync(join(tmpdir(), 'kagi-action-install-'));

    const binary = await installCli(resolvedFor(`${server.url}/${ASSET}`, sha256(archive)), { tempRoot });

    assert.equal(readFileSync(binary, 'utf8'), FAKE_KAGI_SCRIPT);
    assert.equal(statSync(binary).mode & 0o777, 0o755);
    assert.ok(binary.startsWith(join(tempRoot, 'kagi-cli-')));
    assert.deepEqual(readdirSync(join(binary, '..')), ['kagi'], 'only the kagi binary is written');
  });

  test('an archive that does not match the pinned SHA-256 is refused and nothing is written', async () => {
    harness = createHarness();
    const archive = fakeCliArchive();
    server = await startServer({ [`/${ASSET}`]: { body: archive } });
    const tempRoot = mkdtempSync(join(tmpdir(), 'kagi-action-install-'));

    await assert.rejects(
      installCli(resolvedFor(`${server.url}/${ASSET}`, 'c'.repeat(64)), { tempRoot }),
      /does not match the SHA-256 this action pins/
    );
    assert.deepEqual(readdirSync(tempRoot), [], 'nothing may be written for a mismatching archive');
  });

  test('a verified archive without a kagi binary is refused', async () => {
    harness = createHarness();
    const archive = gzipSync(tarArchive([{ name: 'README.md', data: 'no binary here' }]));
    server = await startServer({ [`/${ASSET}`]: { body: archive } });
    const tempRoot = mkdtempSync(join(tmpdir(), 'kagi-action-install-'));

    await assert.rejects(installCli(resolvedFor(`${server.url}/${ASSET}`, sha256(archive)), { tempRoot }), /holds no kagi binary/);
    assert.deepEqual(readdirSync(tempRoot), []);
  });
});

describe('download', () => {
  test('a missing release asset fails at once, without retries', async () => {
    harness = createHarness();
    server = await startServer({});
    await assert.rejects(download(`${server.url}/${ASSET}`, { wait: noWait }), /failed with HTTP 404/);
    assert.equal(server.requests.length, 1);
  });

  test('a 503 is retried and the next answer is used', async () => {
    harness = createHarness();
    server = await startServer({
      [`/${ASSET}`]: (count) => (count === 1 ? { status: 503 } : { body: 'archive-bytes' }),
    });
    const body = await download(`${server.url}/${ASSET}`, { wait: noWait });
    assert.equal(body.toString(), 'archive-bytes');
    assert.equal(server.requests.length, 2);
    assert.ok(harness.lines.some((line) => line.startsWith('::warning::') && line.includes('HTTP 503')));
  });

  test('retries stop after the last attempt', async () => {
    harness = createHarness();
    server = await startServer({ [`/${ASSET}`]: { status: 502 } });
    await assert.rejects(download(`${server.url}/${ASSET}`, { wait: noWait, attempts: 3 }), /HTTP 502/);
    assert.equal(server.requests.length, 3);
  });

  test('a network error is retried', async () => {
    harness = createHarness();
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return fetch(url, options);
    };
    server = await startServer({ [`/${ASSET}`]: { body: 'ok' } });
    const body = await download(`${server.url}/${ASSET}`, { wait: noWait, fetchImpl });
    assert.equal(body.toString(), 'ok');
    assert.equal(calls, 2);
  });

  test('an archive larger than the limit is refused', async () => {
    harness = createHarness();
    server = await startServer({ [`/${ASSET}`]: { body: Buffer.alloc(4096) } });
    await assert.rejects(download(`${server.url}/${ASSET}`, { wait: noWait, maxBytes: 1024 }), /more than the 1024 bytes|larger than the 1024 bytes/);
    assert.equal(server.requests.length, 1, 'a size refusal is not retried');
  });
});
