/**
 * Runs the installed Kagi CLI.
 *
 * The CLI does all of the CI work itself: it requests the job's OIDC id-token, exchanges it for a
 * Kagi token (for the app environment a workload role grants, or for what a legacy CI binding
 * gives), reads the secrets once, masks every value and writes $GITHUB_ENV. This module only starts
 * it with the right arguments and environment and reports how it ended.
 *
 * The CLI's stdout and stderr are inherited, never piped, buffered or silenced. The CLI writes its
 * ::add-mask:: and ::warning:: workflow commands to stderr, and the runner reads workflow commands
 * from both streams of an action's process (actions/runner NodeScriptActionHandler wires stdout and
 * stderr each to an OutputManager). Inherited, those lines reach the runner exactly as the CLI
 * wrote them and before the CLI writes any value anywhere. Captured instead, a mask could arrive
 * after the value it hides, or not at all.
 *
 * The exit code alone decides success. Treating stderr output as failure would fail every job,
 * because the masks and the CLI's progress lines are written there.
 */

import { spawn } from 'node:child_process';
import { ActionError } from './core.js';

/** Writes the secrets into $GITHUB_ENV for the later steps of the job. */
export const PULL_ARGS = Object.freeze(['pull', '--github-env']);

/**
 * The arguments of the main step's pull.
 *
 * With a workload role, the job asks for one app environment, and the roles of the organization
 * decide whether it gets it. `--identity github` makes the CLI use the job's id-token and nothing
 * else: without it, a job that lacks `id-token: write` would go on to the runner's cloud metadata
 * endpoint or a stored session instead of failing with the permission to add.
 *
 * With a legacy CI binding, the binding decides what the job gets, and the CLI refuses any flag
 * that selects secrets, so the pull takes none.
 */
export function pullArgs({ bindingId, appId, environment }) {
  if (bindingId) return [...PULL_ARGS];
  return [...PULL_ARGS, '--identity', 'github', '--app-id', appId, '--env', environment];
}

/** Revokes the GitHub tokens that any `kagi pull` of this job minted and kept under $RUNNER_TEMP. */
export const REVOKE_ARGS = Object.freeze(['ci', 'revoke']);

/** stdin is closed so a CLI that ever prompted would fail instead of hanging the job. */
export const CLI_STDIO = Object.freeze(['ignore', 'inherit', 'inherit']);

/**
 * The environment the CLI runs with: the step's own, plus the action's inputs under the variables
 * the CLI reads. KAGI_API_URL is always set, because a job's id-token goes only to KAGI_API_URL or
 * the production API, never to the api-url of a checked-out kagi.yaml. The audience is set only when
 * given, so an empty input never overrides a value the workflow put in the step's environment.
 *
 * KAGI_BINDING_ID selects the legacy CI binding path in the CLI. It is set from binding-id, and
 * removed when binding-id is empty: a value left in the step's environment would turn a workload
 * role pull into a binding pull, which the CLI then refuses for its --app-id and --env.
 */
export function buildCliEnv(baseEnv, { apiUrl, bindingId, audience }) {
  const env = { ...baseEnv, KAGI_API_URL: apiUrl };
  if (bindingId) env.KAGI_BINDING_ID = bindingId;
  else delete env.KAGI_BINDING_ID;
  if (audience) env.KAGI_AUDIENCE = audience;
  return env;
}

/**
 * Starts the CLI with an argument array and no shell, so no input is ever interpreted by one, and
 * resolves with how it ended. Rejects only when the process could not be started at all.
 */
export function runCli(binary, args, env, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, [...args], { env, stdio: [...CLI_STDIO], shell: false });
    } catch (cause) {
      reject(new ActionError(`Could not start ${binary}: ${cause.message}`, { cause }));
      return;
    }
    child.once('error', (cause) => {
      reject(new ActionError(`Could not start ${binary}: ${cause.message}`, { cause }));
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/** Describes a CLI run that did not succeed, for the step's error annotation. */
export function describeFailure(command, { code, signal }) {
  const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
  return `${command} ${how}. Its own output above says why.`;
}
