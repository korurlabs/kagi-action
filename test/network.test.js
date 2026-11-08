/**
 * Installs the CLI release src/cli-release.json pins, from GitHub, for this machine. Opt-in with
 * KAGI_ACTION_NETWORK=1, so `npm test` stays hermetic; the CI smoke job covers the same path on
 * real runners.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPinnedRelease, resolveRelease } from '../src/release.js';
import { installCli } from '../src/install.js';

test(
  'the pinned release downloads, matches its embedded SHA-256 and runs',
  { skip: process.env.KAGI_ACTION_NETWORK !== '1' && 'set KAGI_ACTION_NETWORK=1 to download from GitHub' },
  async () => {
    const release = loadPinnedRelease();
    const resolved = resolveRelease({ requestedVersion: '', release, platform: process.platform, arch: process.arch });
    const binary = await installCli(resolved, { tempRoot: mkdtempSync(join(tmpdir(), 'kagi-action-net-')) });
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' });
    assert.ok(version.includes(release.version), version);
  }
);
