import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DOWNLOAD_BASE_URL,
  loadPinnedRelease,
  normalizeVersion,
  parsePinnedRelease,
  resolvePlatform,
  resolveRelease,
  supportedAssetNames,
} from '../src/release.js';
import { ActionError } from '../src/core.js';
import { releaseFor } from './helpers.js';

const SHA = 'a'.repeat(64);

describe('runner platform', () => {
  test('maps Linux and macOS on x64 and arm64 to the release names', () => {
    assert.deepEqual(resolvePlatform('linux', 'x64'), { os: 'linux', arch: 'amd64' });
    assert.deepEqual(resolvePlatform('linux', 'arm64'), { os: 'linux', arch: 'arm64' });
    assert.deepEqual(resolvePlatform('darwin', 'x64'), { os: 'darwin', arch: 'amd64' });
    assert.deepEqual(resolvePlatform('darwin', 'arm64'), { os: 'darwin', arch: 'arm64' });
  });

  test('Windows is refused with a message that names it and says what to do', () => {
    assert.throws(
      () => resolvePlatform('win32', 'x64'),
      (error) =>
        error instanceof ActionError &&
        /runs on Linux and macOS runners only, and this job runs on Windows/.test(error.message) &&
        /ubuntu-latest/.test(error.message)
    );
  });

  test('any other platform or architecture is refused', () => {
    assert.throws(() => resolvePlatform('freebsd', 'x64'), /platform 'freebsd'/);
    assert.throws(() => resolvePlatform('linux', 'ia32'), /architecture 'ia32'/);
    assert.throws(() => resolvePlatform('linux', 'arm'), /architecture 'arm'/);
  });
});

describe('version', () => {
  test('accepts a version with or without a leading v', () => {
    assert.equal(normalizeVersion('0.32.0'), '0.32.0');
    assert.equal(normalizeVersion('v0.32.0'), '0.32.0');
    assert.equal(normalizeVersion('1.0.0-rc.1'), '1.0.0-rc.1');
  });

  test('refuses anything that is not a release version', () => {
    for (const bad of ['latest', '0.32', '0.32.0; rm -rf /', '../0.31.1', '']) {
      assert.throws(() => normalizeVersion(bad), ActionError, bad);
    }
  });
});

describe('resolveRelease', () => {
  const release = releaseFor('0.31.1', SHA);

  test('without a version input it installs the pinned version for this runner', () => {
    const resolved = resolveRelease({ requestedVersion: '', release, platform: 'linux', arch: 'x64' });
    assert.deepEqual(resolved, {
      version: '0.31.1',
      assetName: 'kagi-cli_0.31.1_linux_amd64.tar.gz',
      url: 'https://github.com/korurlabs/kagi-cli/releases/download/v0.31.1/kagi-cli_0.31.1_linux_amd64.tar.gz',
      sha256: SHA,
    });
    assert.equal(DOWNLOAD_BASE_URL, 'https://github.com/korurlabs/kagi-cli/releases/download');
  });

  test('the pinned version may be requested explicitly, with or without a v', () => {
    const resolved = resolveRelease({ requestedVersion: 'v0.31.1', release, platform: 'darwin', arch: 'arm64' });
    assert.equal(resolved.assetName, 'kagi-cli_0.31.1_darwin_arm64.tar.gz');
  });

  test('a version input without an embedded checksum is refused', () => {
    assert.throws(
      () => resolveRelease({ requestedVersion: '0.32.0', release, platform: 'linux', arch: 'x64' }),
      (error) =>
        error instanceof ActionError &&
        /Kagi CLI 0\.32\.0 has no SHA-256 embedded/.test(error.message) &&
        /pins 0\.31\.1/.test(error.message)
    );
  });

  test('an unsupported runner is refused before the version is looked at', () => {
    assert.throws(
      () => resolveRelease({ requestedVersion: '0.32.0', release, platform: 'win32', arch: 'x64' }),
      /Windows/
    );
  });
});

describe('the pinned release file', () => {
  test('the committed src/cli-release.json pins every supported asset with a SHA-256', () => {
    const release = loadPinnedRelease();
    assert.deepEqual(Object.keys(release.assets).sort(), supportedAssetNames(release.version));
    for (const sha of Object.values(release.assets)) assert.match(sha, /^[0-9a-f]{64}$/);
  });

  test('its JSON is exactly what scripts/pin-cli.sh writes', () => {
    const text = readFileSync(new URL('../src/cli-release.json', import.meta.url), 'utf8');
    const release = JSON.parse(text);
    const lines = Object.entries(release.assets).map(([name, sha]) => `    "${name}": "${sha}"`);
    const expected = `{\n  "version": "${release.version}",\n  "assets": {\n${lines.join(',\n')}\n  }\n}\n`;
    assert.equal(text, expected);
  });

  test('a malformed pin is refused', () => {
    assert.throws(() => parsePinnedRelease('not json'), /not valid JSON/);
    assert.throws(() => parsePinnedRelease('{"version":"latest","assets":{}}'), /no valid CLI version/);
    const missing = releaseFor('1.0.0', SHA);
    delete missing.assets['kagi-cli_1.0.0_linux_arm64.tar.gz'];
    assert.throws(() => parsePinnedRelease(JSON.stringify(missing)), /must pin exactly/);
    const extra = releaseFor('1.0.0', SHA);
    extra.assets['kagi-cli_1.0.0_windows_amd64.zip'] = SHA;
    assert.throws(() => parsePinnedRelease(JSON.stringify(extra)), /must pin exactly/);
    const uppercase = releaseFor('1.0.0', 'A'.repeat(64));
    assert.throws(() => parsePinnedRelease(JSON.stringify(uppercase)), /lowercase hex SHA-256/);
  });
});
