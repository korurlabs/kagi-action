/**
 * The main and post steps of korurlabs/kagi-action.
 *
 * main: install the pinned, checksum-verified Kagi CLI, put it on PATH, and run
 * `kagi pull --github-env`, which proves the job's identity with its OIDC id-token and writes the
 * secret set Kagi grants this workflow into $GITHUB_ENV.
 *
 * post: run `kagi ci revoke`, which revokes the GitHub tokens Kagi minted for the job. The runner
 * runs it at the end of the job whether the main step succeeded or not.
 */

import { dirname } from 'node:path';
import {
  ActionError,
  addPath,
  debug,
  getBooleanInput,
  getInput,
  getState,
  info,
  saveState,
  setFailed,
} from './core.js';
import { DOWNLOAD_BASE_URL, loadPinnedRelease, resolveRelease } from './release.js';
import { installCli } from './install.js';
import { PULL_ARGS, REVOKE_ARGS, buildCliEnv, describeFailure, runCli } from './cli.js';

/** Kagi's public API, the same default the CLI uses in CI mode. */
export const DEFAULT_API_URL = 'https://api.kagi.pw';

/** The state the main step leaves for the post step: where it installed the CLI. */
export const STATE_BINARY = 'kagiBinary';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Reads and checks every input before anything is downloaded, so a typo fails in a second.
 */
export function readInputs() {
  const bindingId = getInput('binding-id');
  if (bindingId && !UUID_PATTERN.test(bindingId)) {
    throw new ActionError(
      `binding-id must be the binding's id (a UUID) from the Kagi portal, got '${bindingId}'. ` +
        'Leave it unset to let Kagi find the binding from this job.'
    );
  }

  const apiUrl = getInput('api-url', { fallback: DEFAULT_API_URL });
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch (cause) {
    throw new ActionError(`api-url must be an absolute URL, got '${apiUrl}'.`, { cause });
  }
  // The job's id-token travels to this URL. Over plain HTTP anyone on the path could replay it,
  // so plain HTTP is accepted only for a server on this runner itself.
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new ActionError(`api-url must use https, got '${apiUrl}'.`);
  }

  return {
    bindingId,
    apiUrl,
    audience: getInput('audience'),
    version: getInput('version'),
    pull: getBooleanInput('pull', true),
  };
}

export async function main({
  platform = process.platform,
  arch = process.arch,
  release,
  downloadBaseUrl = DOWNLOAD_BASE_URL,
  fetchImpl,
  spawnImpl,
  tempRoot,
} = {}) {
  const inputs = readInputs();
  const resolved = resolveRelease({
    requestedVersion: inputs.version,
    release: release ?? loadPinnedRelease(),
    platform,
    arch,
    baseUrl: downloadBaseUrl,
  });

  info(`Installing the Kagi CLI ${resolved.version} from ${resolved.url}`);
  const binary = await installCli(resolved, { fetchImpl, tempRoot });
  info(`Verified ${resolved.assetName} against the SHA-256 this action pins (${resolved.sha256}).`);

  // Saved before the pull runs: a pull that fails after Kagi minted GitHub tokens still leaves
  // them on disk, and the post step must find the CLI to revoke them.
  saveState(STATE_BINARY, binary);
  addPath(dirname(binary));
  info(`Installed kagi at ${binary} and put it on PATH for the later steps of this job.`);

  if (!inputs.pull) {
    info(
      'pull is false, so no secrets were read. Run `kagi run -- <command>` in the step that needs ' +
        'them, which hands the secret set to that one command.'
    );
    return;
  }

  const env = buildCliEnv(process.env, inputs);
  const result = await runCli(binary, PULL_ARGS, env, { spawnImpl });
  if (result.code !== 0) {
    throw new ActionError(describeFailure('kagi pull --github-env', result));
  }
}

/**
 * Follows what the CLI returns. `kagi ci revoke` exits 0 when there is nothing to revoke and when a
 * token could not be revoked (it warns, and GitHub ends the token within the hour), so a failed
 * post step means the revoke itself could not run.
 */
export async function post({ spawnImpl } = {}) {
  const binary = getState(STATE_BINARY);
  if (!binary) {
    info('The Kagi CLI was not installed in this job, so it minted no GitHub tokens to revoke.');
    return;
  }
  const result = await runCli(binary, REVOKE_ARGS, { ...process.env }, { spawnImpl });
  if (result.code !== 0) {
    throw new ActionError(describeFailure('kagi ci revoke', result));
  }
}

/** Every failure of either step ends here and fails that step. */
export function reportFailure(error) {
  if (error?.cause) {
    debug(`Underlying cause: ${error.cause.stack ?? error.cause}`);
  }
  if (!(error instanceof ActionError)) {
    debug(error?.stack ?? String(error));
  }
  setFailed(error?.message ?? String(error));
}
