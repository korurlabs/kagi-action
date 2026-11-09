/**
 * Runs the installed Kagi CLI.
 *
 * The CLI does all of the CI work itself: it requests the job's OIDC id-token, exchanges it,
 * reads what the job's binding gives once, masks every value and writes $GITHUB_ENV. This module
 * only starts it with the right arguments and environment and reports how it ended.
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

/** Writes the binding's secrets into $GITHUB_ENV for the later steps of the job. */
export const PULL_ARGS = Object.freeze(['pull', '--github-env']);

/** Revokes the GitHub tokens that any `kagi pull` of this job minted and kept under $RUNNER_TEMP. */
export const REVOKE_ARGS = Object.freeze(['ci', 'revoke']);

/** stdin is closed so a CLI that ever prompted would fail instead of hanging the job. */
export const CLI_STDIO = Object.freeze(['ignore', 'inherit', 'inherit']);

/**
 * The environment the CLI runs with: the step's own, plus the action's inputs under the variables
 * CI mode reads. KAGI_API_URL is always set, because in CI mode the CLI ignores the api-url of a
 * checked-out kagi.yaml and uses only KAGI_API_URL or its production default. The binding id and
 * the audience are set only when given, so an empty input never overrides a value the workflow put
 * in the step's environment, and Kagi finds the binding from the job's claims when none is named.
 */
export function buildCliEnv(baseEnv, { apiUrl, bindingId, audience }) {
  const env = { ...baseEnv, KAGI_API_URL: apiUrl };
  if (bindingId) env.KAGI_BINDING_ID = bindingId;
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
