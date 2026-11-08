import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EOL } from 'node:os';
import { delimiter } from 'node:path';
import { createHarness, setInput } from './helpers.js';
import {
  ActionError,
  addPath,
  escapeData,
  getBooleanInput,
  getInput,
  getState,
  saveState,
  setFailed,
  warning,
} from '../src/core.js';

let harness;
afterEach(() => harness?.restore());

describe('workflow commands', () => {
  test('escapes the characters that would end or corrupt a command', () => {
    assert.equal(escapeData('a%b\rc\nd'), 'a%25b%0Dc%0Ad');
  });

  test('a multi-line warning stays one command', () => {
    harness = createHarness();
    warning('first\nsecond');
    assert.deepEqual(harness.lines, ['::warning::first%0Asecond']);
  });

  test('setFailed writes an error command and sets a failing exit code', () => {
    harness = createHarness();
    setFailed('it broke');
    assert.deepEqual(harness.lines, ['::error::it broke']);
    assert.equal(process.exitCode, 1);
  });
});

describe('inputs', () => {
  test('reads and trims INPUT_* variables, keeping dashes in the name', () => {
    harness = createHarness({ 'binding-id': '  abc  ' });
    assert.equal(process.env['INPUT_BINDING-ID'], '  abc  ');
    assert.equal(getInput('binding-id'), 'abc');
  });

  test('an absent or blank input falls back', () => {
    harness = createHarness({ 'api-url': '   ' });
    assert.equal(getInput('api-url', { fallback: 'https://api.kagi.pw' }), 'https://api.kagi.pw');
    assert.equal(getInput('version'), '');
  });

  test('boolean inputs accept only the YAML core-schema spellings', () => {
    harness = createHarness({ pull: 'False' });
    assert.equal(getBooleanInput('pull', true), false);
    setInput('pull', 'TRUE');
    assert.equal(getBooleanInput('pull', false), true);
    setInput('pull', 'no');
    assert.throws(() => getBooleanInput('pull', true), ActionError);
  });
});

describe('runner files', () => {
  test('saveState writes a heredoc entry with a random delimiter', () => {
    harness = createHarness();
    saveState('kagiBinary', '/tmp/kagi-cli-x/kagi');
    const [entry] = harness.stateWrites();
    const match = entry.match(/^kagiBinary<<(ghadelimiter_[0-9a-f-]{36})\r?\n\/tmp\/kagi-cli-x\/kagi\r?\n(.+)\r?\n$/);
    assert.ok(match, entry);
    assert.equal(match[1], match[2]);
  });

  test('getState reads the STATE_ variable the runner gives the post step', () => {
    harness = createHarness();
    assert.equal(getState('kagiBinary'), '');
    process.env.STATE_kagiBinary = '/x/kagi';
    assert.equal(getState('kagiBinary'), '/x/kagi');
  });

  test('addPath appends the directory to GITHUB_PATH and prepends it to PATH', () => {
    harness = createHarness();
    process.env.PATH = '/usr/bin';
    addPath('/tmp/kagi-cli-x');
    assert.deepEqual(harness.pathWrites(), [`/tmp/kagi-cli-x${EOL}`]);
    assert.equal(process.env.PATH, `/tmp/kagi-cli-x${delimiter}/usr/bin`);
  });

  test('outside GitHub Actions the runner files are missing and that is an error', () => {
    harness = createHarness();
    delete process.env.GITHUB_STATE;
    delete process.env.GITHUB_PATH;
    assert.throws(() => saveState('a', 'b'), /GITHUB_STATE is not set/);
    assert.throws(() => addPath('/x'), /GITHUB_PATH is not set/);
  });
});
