import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_STDIO, PULL_ARGS, REVOKE_ARGS, buildCliEnv, describeFailure, runCli } from '../src/cli.js';
import { ActionError } from '../src/core.js';
import { stubSpawn, writeFakeKagi } from './helpers.js';

describe('arguments', () => {
  test('the main step runs kagi pull --github-env and the post step kagi ci revoke', () => {
    assert.deepEqual([...PULL_ARGS], ['pull', '--github-env']);
    assert.deepEqual([...REVOKE_ARGS], ['ci', 'revoke']);
  });

  test('inputs reach the CLI as the variables CI mode reads, set only when given', () => {
    const base = { PATH: '/usr/bin', GITHUB_ENV: '/tmp/env' };
    assert.deepEqual(buildCliEnv(base, { apiUrl: 'https://api.kagi.pw', bindingId: '', audience: '' }), {
      PATH: '/usr/bin',
      GITHUB_ENV: '/tmp/env',
      KAGI_API_URL: 'https://api.kagi.pw',
    });
    const id = '3fa2c1e0-0000-4000-8000-000000000000';
    const env = buildCliEnv(base, { apiUrl: 'https://kagi.example', bindingId: id, audience: 'kagi.example' });
    assert.equal(env.KAGI_API_URL, 'https://kagi.example');
    assert.equal(env.KAGI_BINDING_ID, id);
    assert.equal(env.KAGI_AUDIENCE, 'kagi.example');
    assert.equal(base.KAGI_API_URL, undefined, 'the step environment itself is not changed');
  });

  test('the api-url input wins over a KAGI_API_URL already in the step environment', () => {
    const env = buildCliEnv({ KAGI_API_URL: 'https://elsewhere.example' }, { apiUrl: 'https://api.kagi.pw' });
    assert.equal(env.KAGI_API_URL, 'https://api.kagi.pw');
  });

  test('an empty binding-id keeps a KAGI_BINDING_ID the workflow set on the step', () => {
    const env = buildCliEnv({ KAGI_BINDING_ID: 'from-workflow' }, { apiUrl: 'https://api.kagi.pw', bindingId: '' });
    assert.equal(env.KAGI_BINDING_ID, 'from-workflow');
  });
});

describe('runCli', () => {
  test('spawns with an argument array, no shell, and stdout and stderr inherited', async () => {
    const spawn = stubSpawn();
    const result = await runCli('/opt/kagi', PULL_ARGS, { A: '1' }, { spawnImpl: spawn.impl });
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(spawn.calls.length, 1);
    const [{ binary, args, options }] = spawn.calls;
    assert.equal(binary, '/opt/kagi');
    assert.deepEqual(args, ['pull', '--github-env']);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit']);
    assert.deepEqual([...CLI_STDIO], ['ignore', 'inherit', 'inherit']);
    assert.deepEqual(options.env, { A: '1' });
  });

  test('resolves with the exit code of a real process', async () => {
    const fake = writeFakeKagi('#!/bin/sh\nexit 7\n');
    assert.deepEqual(await runCli(fake, ['x'], { PATH: process.env.PATH }), { code: 7, signal: null });
  });

  test('a binary that cannot be started rejects with an ActionError', async () => {
    await assert.rejects(
      runCli('/nonexistent/kagi', ['x'], {}),
      (error) => error instanceof ActionError && /Could not start \/nonexistent\/kagi/.test(error.message)
    );
  });

  test('a failure is described by exit code or signal', () => {
    assert.equal(
      describeFailure('kagi pull --github-env', { code: 1, signal: null }),
      'kagi pull --github-env exited with code 1. Its own output above says why.'
    );
    assert.equal(
      describeFailure('kagi ci revoke', { code: null, signal: 'SIGKILL' }),
      'kagi ci revoke was stopped by SIGKILL. Its own output above says why.'
    );
  });
});
