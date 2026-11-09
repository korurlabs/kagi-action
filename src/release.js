/**
 * Which Kagi CLI archive this runner needs, where it comes from, and the SHA-256 it must have.
 *
 * The checksums live in cli-release.json, inside this action. The release's own checksums file is
 * fetched only by scripts/pin-cli.sh, at pin time: read at run time from the same place as the
 * archive, it would prove only that the archive and its checksum were swapped together. Embedded,
 * the hash is part of the commit a workflow pins, so a release asset that changes after the pin is
 * refused instead of run.
 */

import { readFileSync } from 'node:fs';
import { ActionError } from './core.js';

export const DOWNLOAD_BASE_URL = 'https://github.com/korurlabs/kagi-cli/releases/download';

const PINNED_RELEASE_FILE = new URL('./cli-release.json', import.meta.url);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Node's names for the runners this action supports, mapped to the names the release uses. */
const OPERATING_SYSTEMS = { linux: 'linux', darwin: 'darwin' };
const ARCHITECTURES = { x64: 'amd64', arm64: 'arm64' };

/** The archive names an action release must pin, one per supported runner. */
export function supportedAssetNames(version) {
  const names = [];
  for (const os of Object.values(OPERATING_SYSTEMS)) {
    for (const arch of Object.values(ARCHITECTURES)) {
      names.push(assetName(version, os, arch));
    }
  }
  return names.sort();
}

function assetName(version, os, arch) {
  return `kagi-cli_${version}_${os}_${arch}.tar.gz`;
}

/**
 * Maps the runner's platform and architecture to the release's names, or refuses the runner.
 * Windows is refused by name, because it is the runner a user is most likely to try.
 */
export function resolvePlatform(platform, arch) {
  if (platform === 'win32') {
    throw new ActionError(
      'korurlabs/kagi-action runs on Linux and macOS runners only, and this job runs on Windows. ' +
        'Run this job on a Linux or macOS runner (for example ubuntu-latest).'
    );
  }
  const os = OPERATING_SYSTEMS[platform];
  if (!os) {
    throw new ActionError(
      `korurlabs/kagi-action runs on Linux and macOS runners only, and this runner reports the ` +
        `platform '${platform}'.`
    );
  }
  const releaseArch = ARCHITECTURES[arch];
  if (!releaseArch) {
    throw new ActionError(
      `korurlabs/kagi-action supports x64 and arm64 runners only, and this runner reports the ` +
        `architecture '${arch}'.`
    );
  }
  return { os, arch: releaseArch };
}

/** Accepts 1.2.3 and v1.2.3, and refuses anything else, such as "latest". */
export function normalizeVersion(raw) {
  const version = String(raw).trim().replace(/^v/, '');
  if (!VERSION_PATTERN.test(version)) {
    throw new ActionError(
      `Input version must be a Kagi CLI release such as 1.2.3, got '${raw}'.`
    );
  }
  return version;
}

/**
 * Parses and checks the pinned release. A malformed file is a defect in this action's release,
 * so it fails before anything is downloaded.
 */
export function parsePinnedRelease(text) {
  let release;
  try {
    release = JSON.parse(text);
  } catch (cause) {
    throw new ActionError('src/cli-release.json is not valid JSON.', { cause });
  }
  const version = release?.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ActionError('src/cli-release.json names no valid CLI version.');
  }
  const assets = release.assets;
  if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) {
    throw new ActionError('src/cli-release.json has no assets object.');
  }
  const expected = supportedAssetNames(version);
  const actual = Object.keys(assets).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ActionError(
      `src/cli-release.json must pin exactly ${expected.join(', ')}; it pins ${actual.join(', ') || 'nothing'}.`
    );
  }
  for (const [name, sha256] of Object.entries(assets)) {
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      throw new ActionError(`src/cli-release.json has no lowercase hex SHA-256 for ${name}.`);
    }
  }
  return { version, assets: { ...assets } };
}

export function loadPinnedRelease() {
  return parsePinnedRelease(readFileSync(PINNED_RELEASE_FILE, 'utf8'));
}

/**
 * Chooses the archive to install. A requested version other than the pinned one is refused before
 * any download: this action has no checksum for it, and an unverified binary is never run.
 */
export function resolveRelease({ requestedVersion, release, platform, arch, baseUrl = DOWNLOAD_BASE_URL }) {
  const runner = resolvePlatform(platform, arch);
  const version = requestedVersion ? normalizeVersion(requestedVersion) : release.version;
  if (version !== release.version) {
    throw new ActionError(
      `Kagi CLI ${version} has no SHA-256 embedded in this release of korurlabs/kagi-action, which ` +
        `pins ${release.version}. The action installs only a CLI it can verify. Remove the version ` +
        `input to use ${release.version}, or use a kagi-action release that pins ${version}.`
    );
  }
  const name = assetName(version, runner.os, runner.arch);
  const sha256 = release.assets[name];
  if (!sha256) {
    throw new ActionError(`This release of korurlabs/kagi-action pins no SHA-256 for ${name}.`);
  }
  return { version, assetName: name, url: `${baseUrl}/v${version}/${name}`, sha256 };
}
