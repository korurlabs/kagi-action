/**
 * Downloads the pinned Kagi CLI archive, verifies it, and installs the kagi binary.
 *
 * Order matters: the whole archive is hashed and compared with the pinned SHA-256 before it is
 * decompressed or read, so nothing from an archive that does not match is ever parsed, written to
 * disk or run.
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ActionError, warning } from './core.js';
import { extractRegularFile } from './tar.js';

/** The CLI archives are about 5 MB; the limits only stop a runaway download or decompression. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 5_000];

const BINARY_NAME = 'kagi';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCapped(response, maxBytes, url) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ActionError(`${url} is ${declared} bytes, more than the ${maxBytes} bytes this action accepts.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new ActionError(`${url} is larger than the ${maxBytes} bytes this action accepts.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads url into memory. Network errors, timeouts, 429 and 5xx answers are retried; any other
 * answer, such as a 404 for a release that does not exist, fails at once.
 */
export async function download(
  url,
  {
    fetchImpl = fetch,
    maxBytes = MAX_ARCHIVE_BYTES,
    attempts = DOWNLOAD_ATTEMPTS,
    backoffMs = RETRY_BACKOFF_MS,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    wait = sleep,
  } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    let transient = false;
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'korurlabs-kagi-action' },
      });
      if (!response.ok) {
        transient = response.status === 429 || response.status >= 500;
        throw new ActionError(`Downloading ${url} failed with HTTP ${response.status}.`);
      }
      return await readCapped(response, maxBytes, url);
    } catch (error) {
      const failure =
        error instanceof ActionError
          ? error
          : new ActionError(`Downloading ${url} failed: ${error?.message ?? error}`, { cause: error });
      if (!(error instanceof ActionError)) transient = true;
      if (!transient || attempt >= attempts) throw failure;
      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
      warning(`${failure.message} Retrying in ${delay / 1000}s (attempt ${attempt + 1} of ${attempts}).`);
      await wait(delay);
    }
  }
}

/** Refuses an archive whose SHA-256 is not the pinned one. */
export function verifySha256(archive, expected, assetName) {
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new ActionError(
      `${assetName} does not match the SHA-256 this action pins: expected ${expected}, got ` +
        `${actual}. Nothing from it was extracted or run. The release asset changed after this ` +
        'action release pinned it; report it to Kagi.'
    );
  }
}

/**
 * Installs the CLI for `resolved` (from resolveRelease) into a new directory under tempRoot and
 * returns the path of the kagi binary.
 */
export async function installCli(resolved, { tempRoot = process.env.RUNNER_TEMP || tmpdir(), ...downloadOptions } = {}) {
  const archive = await download(resolved.url, downloadOptions);
  verifySha256(archive, resolved.sha256, resolved.assetName);

  let tarball;
  try {
    tarball = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (cause) {
    throw new ActionError(`${resolved.assetName} could not be decompressed: ${cause.message}`, { cause });
  }
  const binary = extractRegularFile(tarball, BINARY_NAME);

  const directory = mkdtempSync(join(tempRoot, 'kagi-cli-'));
  const binaryPath = join(directory, BINARY_NAME);
  writeFileSync(binaryPath, binary, { mode: 0o755, flag: 'wx' });
  // The mode given to writeFileSync is narrowed by the umask; the binary must be executable.
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}
