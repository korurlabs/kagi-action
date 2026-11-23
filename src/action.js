/**
 * The main and post steps of korurlabs/kagi-action.
 *
 * main: install the pinned, checksum-verified Kagi CLI, put it on PATH, and run
 * `kagi pull --github-env`, which proves the job's identity with its OIDC id-token and writes into
 * $GITHUB_ENV the secrets of the app environment a Kagi workload role grants this job, or, with
 * binding-id, what a legacy Kagi CI binding gives.
 *
 * post: run `kagi ci revoke`, which revokes the GitHub tokens a legacy CI binding had Kagi mint for
 * the job. The runner runs it at the end of the job whether the main step succeeded or not.
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
  warning,
} from './core.js';
import { DOWNLOAD_BASE_URL, loadPinnedRelease, resolveRelease } from './release.js';
import { installCli } from './install.js';
import { REVOKE_ARGS, buildCliEnv, describeFailure, pullArgs, runCli } from './cli.js';

/** Kagi's public API, the same default the CLI uses in CI mode. */
export const DEFAULT_API_URL = 'https://api.kagi.pw';

/** The state the main step leaves for the post step: where it installed the CLI. */
export const STATE_BINARY = 'kagiBinary';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** An environment slug as Kagi shows it, such as production or staging. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Where an org admin creates the workload role, named in every error about the role inputs. */
const ROLE_SETUP_HINT =
  'In the Kagi portal, open Integrations, connect GitHub Actions and add a workload role that ' +
  'matches this repository and grants that app environment.';

/**
 * Reads and checks every input before anything is downloaded, so a typo fails in a second.
 */
export function readInputs() {
  const bindingId = getInput('binding-id');
  if (bindingId && !UUID_PATTERN.test(bindingId)) {
    throw new ActionError(
      `binding-id must be the id (a UUID) of a legacy Kagi CI binding, got '${bindingId}'. ` +
        'Leave it unset to read through a workload role with app-id and environment.'
    );
  }

  const appId = getInput('app-id');
  if (appId && !UUID_PATTERN.test(appId)) {
    throw new ActionError(
      `app-id must be the Kagi app's id (a UUID), got '${appId}'. The app's page in the Kagi portal shows it.`
    );
  }
  const environment = getInput('environment');
  if (environment && !ENVIRONMENT_PATTERN.test(environment)) {
    throw new ActionError(
      `environment must be the slug of an environment of the Kagi app, such as production, got '${environment}'.`
    );
  }

  const pull = getBooleanInput('pull', true);
  if (bindingId && (appId || environment)) {
    throw new ActionError(
      'binding-id selects a legacy Kagi CI binding, and the binding decides which secrets the job ' +
        'gets, so app-id and environment cannot be used with it. Remove binding-id to read through ' +
        'a workload role, or remove app-id and environment to keep the binding.'
    );
  }
  if (Boolean(appId) !== Boolean(environment)) {
    const missing = appId ? 'environment' : 'app-id';
    throw new ActionError(
      `app-id and environment go together: they name the app environment a Kagi workload role ` +
        `grants this job. Set ${missing} as well.`
    );
  }
  if (pull && !bindingId && !appId) {
    throw new ActionError(
      'Set app-id and environment: they name the Kagi app environment whose secrets this job ' +
        `reads through a workload role. ${ROLE_SETUP_HINT} A job that still uses a legacy CI ` +
        'binding sets binding-id instead.'
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
    appId,
    environment,
    apiUrl,
    audience: getInput('audience'),
    version: getInput('version'),
    pull,
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
    const target = inputs.appId
      ? `--app-id ${inputs.appId} --env ${inputs.environment}`
      : '--app-id <app id> --env <environment>';
    info(
      'pull is false, so no secrets were read. Run ' +
        `\`kagi run --identity github ${target} -- <command>\` in the step that needs them, which ` +
        'hands the secrets to that one command.'
    );
    return;
  }

  if (!inputs.bindingId && process.env.KAGI_BINDING_ID) {
    warning(
      'KAGI_BINDING_ID is set in this step, but binding-id is not, so it was ignored and the job ' +
        'reads through a workload role. To keep a legacy CI binding, set the binding-id input.'
    );
  }
  const env = buildCliEnv(process.env, inputs);
  const result = await runCli(binary, pullArgs(inputs), env, { spawnImpl });
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
