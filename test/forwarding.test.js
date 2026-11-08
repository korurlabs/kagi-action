/**
 * Runs the real main and post steps in a child process, as the runner does, with a fake kagi
 * served as a checksum-verified release archive. Proves that what the CLI writes to stdout and
 * stderr reaches the action's own streams untouched: the runner reads ::add-mask:: from the
 * action's process, so a CLI whose output were captured or silenced would leave values unmasked.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCliArchive, releaseFor, sha256, startServer } from './helpers.js';

const HARNESS = new URL('./fixtures/run-action.js', import.meta.url).pathname;
const OS = { linux: 'linux', darwin: 'darwin' }[process.platform];
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];

let server;
let fixture;
before(async () => {
  const archive = fakeCliArchive();
  server = await startServer({ [`/v9.9.9/kagi-cli_9.9.9_${OS}_${ARCH}.tar.gz`]: { body: archive } });
  fixture = { release: releaseFor('9.9.9', sha256(archive)), downloadBaseUrl: server.url };
});
after(() => server?.close());

/** Runs a step without blocking this process, which also serves the archive. */
function runStep(step, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, step], {
      env: { ...env, KAGI_ACTION_FIXTURE: JSON.stringify(fixture) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runnerEnv(dir, inputs = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    RUNNER_TEMP: dir,
    GITHUB_STATE: join(dir, 'github_state'),
    GITHUB_PATH: join(dir, 'github_path'),
    GITHUB_ENV: join(dir, 'github_env'),
  };
  for (const file of [env.GITHUB_STATE, env.GITHUB_PATH, env.GITHUB_ENV]) writeFileSync(file, '');
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  return env;
}

/** Reads the heredoc entries of a runner file command, as the runner does. */
function readState(file) {
  const state = {};
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([^<]+)<<(.+)$/);
    if (!match) continue;
    const value = [];
    for (index += 1; lines[index] !== match[2]; index += 1) value.push(lines[index]);
    state[match[1]] = value.join('\n');
  }
  return state;
}

describe('the CLI output reaches the runner untouched', { skip: !OS || !ARCH }, () => {
  test('main: the fake kagi stdout and its stderr ::add-mask:: line come out of the action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagi-action-fwd-'));
    const marker = join(dir, 'shell-ran');
    const result = await runStep('main', runnerEnv(dir, { audience: `$(touch ${marker})` }));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^fake-kagi args: pull --github-env$/m);
    assert.match(result.stdout, /^fake-kagi KAGI_API_URL=https:\/\/api\.kagi\.pw$/m);
    assert.match(result.stdout, /^fake-kagi KAGI_BINDING_ID=<unset>$/m);
    assert.match(result.stderr, /^::add-mask::fake-secret-value$/m, 'the CLI stderr must reach the runner');
    assert.match(result.stderr, /^fake-kagi wrote to stderr$/m);

    // The input reached the CLI as data. No shell ever saw it, so the command substitution in it
    // was never run.
    assert.ok(result.stdout.includes(`fake-kagi KAGI_AUDIENCE=$(touch ${marker})`));
    assert.equal(existsSync(marker), false);

    const binary = readState(join(dir, 'github_state')).kagiBinary;
    assert.ok(binary && binary.endsWith('/kagi'), JSON.stringify(readState(join(dir, 'github_state'))));
    assert.equal(readFileSync(join(dir, 'github_path'), 'utf8').trim(), binary.slice(0, -'/kagi'.length));
  });

  test('main: a failing pull fails the step after the CLI had its say', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagi-action-fwd-'));
    const result = await runStep('main', { ...runnerEnv(dir), FAKE_KAGI_EXIT: '3' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^::add-mask::fake-secret-value$/m);
    assert.match(result.stdout, /^::error::kagi pull --github-env exited with code 3\. Its own output above says why\.$/m);
  });

  test('post: kagi ci revoke runs with the CLI the main step installed, and its output is forwarded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagi-action-fwd-'));
    const installed = await runStep('main', runnerEnv(dir, { pull: 'false' }));
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    const binary = readState(join(dir, 'github_state')).kagiBinary;

    const result = await runStep('post', { ...runnerEnv(dir), STATE_kagiBinary: binary });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^fake-kagi args: ci revoke$/m);
    assert.match(result.stderr, /^fake-kagi wrote to stderr$/m);
  });

  test('post: a non-zero revoke fails the post step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagi-action-fwd-'));
    const installed = await runStep('main', runnerEnv(dir, { pull: 'false' }));
    const binary = readState(join(dir, 'github_state')).kagiBinary;
    assert.equal(installed.code, 0);

    const result = await runStep('post', { ...runnerEnv(dir), STATE_kagiBinary: binary, FAKE_KAGI_EXIT: '4' });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /kagi ci revoke exited with code 4/);
  });
});
