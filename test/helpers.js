/**
 * Shared test helpers: a harness that records what the action writes, a tar builder, a local HTTP
 * server, and a fake kagi binary.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sinks } from '../src/core.js';

/** Sets an action input the way the runner does: uppercased, spaces to underscores, dashes kept. */
export function setInput(name, value) {
  process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = String(value);
}

/**
 * Records every line written to stdout and every runner file command, and restores the process
 * environment afterwards (the action changes PATH and reads INPUT_* and STATE_* variables).
 */
export function createHarness(inputs = {}) {
  const originalEnv = { ...process.env };
  const originalStdout = sinks.stdout;
  const originalAppend = sinks.appendFile;
  const lines = [];
  const files = [];

  const dir = mkdtempSync(join(tmpdir(), 'kagi-action-test-'));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key.startsWith('STATE_') || key.startsWith('KAGI_')) {
      delete process.env[key];
    }
  }
  process.env.GITHUB_STATE = join(dir, 'github_state');
  process.env.GITHUB_PATH = join(dir, 'github_path');
  process.env.GITHUB_ENV = join(dir, 'github_env');
  process.exitCode = 0;
  for (const [name, value] of Object.entries(inputs)) setInput(name, value);

  sinks.stdout = (line) => lines.push(line);
  sinks.appendFile = (file, contents) => files.push({ file, contents });

  return {
    dir,
    lines,
    files,
    stateWrites: () => files.filter((f) => f.file === process.env.GITHUB_STATE).map((f) => f.contents),
    pathWrites: () => files.filter((f) => f.file === process.env.GITHUB_PATH).map((f) => f.contents),
    errors: () => lines.filter((l) => l.startsWith('::error::')),
    restore() {
      sinks.stdout = originalStdout;
      sinks.appendFile = originalAppend;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
      process.exitCode = 0;
    },
  };
}

/** A spawn stand-in that records each call and ends the "process" with the given result. */
export function stubSpawn({ code = 0, signal = null, error = null } = {}) {
  const calls = [];
  const impl = (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    setImmediate(() => {
      if (error) child.emit('error', error);
      else child.emit('close', code, signal);
    });
    return child;
  };
  return { impl, calls };
}

function writeOctal(buffer, offset, length, value) {
  buffer.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'latin1');
}

/** One tar entry (header and padded data) in the POSIX ustar format. */
export function tarEntry({ name, data = '', type = '0', mode = 0o644, prefix = '', linkname = '', magic = 'ustar\u000000' }) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'latin1');
  header.write(linkname, 157, 100, 'utf8');
  header.write(magic, 257, 8, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

/** PAX extended header records, each "<length> <key>=<value>\n" with the length counting itself. */
export function paxData(records) {
  let out = '';
  for (const [key, value] of Object.entries(records)) {
    const tail = ` ${key}=${value}\n`;
    let length = tail.length + 1;
    while (String(length).length + tail.length !== length) length += 1;
    out += `${length}${tail}`;
  }
  return out;
}

export function tarArchive(entries) {
  return Buffer.concat([...entries.map((entry) => tarEntry(entry)), Buffer.alloc(1024)]);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * A fake kagi: prints its arguments and the Kagi variables it was given to stdout, a workflow
 * command and a line to stderr, and exits with FAKE_KAGI_EXIT (default 0).
 */
export const FAKE_KAGI_SCRIPT = `#!/bin/sh
printf 'fake-kagi args: %s\\n' "$*"
printf 'fake-kagi KAGI_API_URL=%s\\n' "\${KAGI_API_URL-<unset>}"
printf 'fake-kagi KAGI_BINDING_ID=%s\\n' "\${KAGI_BINDING_ID-<unset>}"
printf 'fake-kagi KAGI_AUDIENCE=%s\\n' "\${KAGI_AUDIENCE-<unset>}"
printf '::add-mask::fake-secret-value\\n' >&2
printf 'fake-kagi wrote to stderr\\n' >&2
exit "\${FAKE_KAGI_EXIT:-0}"
`;

/** A release archive shaped like the real one: LICENSE, README.md and the kagi binary. */
export function fakeCliArchive(script = FAKE_KAGI_SCRIPT) {
  return gzipSync(
    tarArchive([
      { name: 'LICENSE', data: 'MIT' },
      { name: 'README.md', data: '# kagi' },
      { name: 'kagi', data: script, mode: 0o755 },
    ])
  );
}

/** A pinned release whose every supported asset has the given SHA-256. */
export function releaseFor(version, sha) {
  const assets = {};
  for (const os of ['darwin', 'linux']) {
    for (const arch of ['amd64', 'arm64']) {
      assets[`kagi-cli_${version}_${os}_${arch}.tar.gz`] = sha;
    }
  }
  return { version, assets };
}

/** Writes an executable fake kagi into a fresh directory and returns its path. */
export function writeFakeKagi(script = FAKE_KAGI_SCRIPT) {
  const dir = mkdtempSync(join(tmpdir(), 'kagi-action-fake-'));
  const path = join(dir, 'kagi');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Serves `routes` (path to { status, body }) on 127.0.0.1 and records every request path.
 * A route may also be a function of the request count for that path.
 */
export async function startServer(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const route = routes[request.url];
    const answer = typeof route === 'function' ? route(requests.filter((u) => u === request.url).length) : route;
    if (!answer) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(answer.status ?? 200, { 'content-type': 'application/octet-stream' });
    response.end(answer.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
