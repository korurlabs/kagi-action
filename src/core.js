/**
 * A hand-written, zero-dependency subset of @actions/core.
 *
 * Why not depend on @actions/core: a JavaScript action must ship its dependencies inside the repo,
 * either as a committed node_modules or as a bundled dist/index.js produced by ncc. Both mean the
 * code that installs the binary which handles a customer's secrets is not the code a customer can
 * read in this repo. Being auditable line by line at the commit they pin is worth more than reusing
 * a handful of toolkit functions. Everything below mirrors @actions/core's observable behaviour
 * (workflow command escaping, the heredoc of the runner's file commands, boolean input parsing) and
 * is covered by tests.
 */

import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { delimiter as PATH_DELIMITER } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Error whose message is safe to show the user verbatim via setFailed. */
export class ActionError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ActionError';
  }
}

/**
 * Escapes a workflow command's message payload.
 * Identical to the toolkit's escapeData: a raw newline would terminate the command early, and a
 * raw % would corrupt the runner's own unescaping.
 */
export function escapeData(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Where this module writes. Swappable so the tests can record every line and every file command
 * without touching the real process streams or runner files.
 */
export const sinks = {
  stdout: (line) => process.stdout.write(line + EOL),
  appendFile: (file, contents) => appendFileSync(file, contents, { encoding: 'utf8' }),
};

function issueCommand(command, message) {
  sinks.stdout(`::${command}::${escapeData(message)}`);
}

export function info(message) {
  sinks.stdout(message);
}

export function warning(message) {
  issueCommand('warning', message);
}

export function debug(message) {
  issueCommand('debug', message);
}

export function setFailed(message) {
  issueCommand('error', message);
  process.exitCode = 1;
}

/**
 * Reads an action input from its INPUT_* environment variable. The runner uppercases the name and
 * turns spaces into underscores, but keeps dashes (INPUT_BINDING-ID).
 */
export function getInput(name, { fallback = '' } = {}) {
  const raw = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? fallback : value;
}

/**
 * Reads a boolean input, accepting only the YAML 1.2 core-schema spellings the toolkit accepts.
 * Anything else throws rather than being coerced: silently reading a typo'd "no" as true would
 * turn `pull: no` into a job that writes its secrets into the environment of every later step.
 */
export function getBooleanInput(name, fallback) {
  const value = getInput(name);
  if (value === '') return fallback;
  if (['true', 'True', 'TRUE'].includes(value)) return true;
  if (['false', 'False', 'FALSE'].includes(value)) return false;
  throw new ActionError(
    `Input ${name} does not meet YAML 1.2 "Core Schema" specification: got '${value}', expected true or false`
  );
}

function runnerFile(variable) {
  const file = process.env[variable];
  if (!file) {
    throw new ActionError(`${variable} is not set; this action must run inside GitHub Actions.`);
  }
  return file;
}

/**
 * Appends one entry in the heredoc form of the runner's file commands. The delimiter is a fresh
 * UUID per entry, and a value that contains it is refused: written anyway, it would close the
 * entry early and let the rest of the value inject entries of its own.
 */
function appendKeyValue(file, key, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (key.includes(delimiter) || value.includes(delimiter)) {
    throw new ActionError(`Unexpected delimiter collision while writing '${key}'`);
  }
  sinks.appendFile(file, `${key}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}

/** Hands a value from the main step to the post step, which reads it back with getState. */
export function saveState(name, value) {
  appendKeyValue(runnerFile('GITHUB_STATE'), name, String(value));
}

/** Reads a value the main step saved; the runner gives it to the post step as STATE_<name>. */
export function getState(name) {
  return process.env[`STATE_${name}`] ?? '';
}

/**
 * Puts a directory on PATH for the later steps of the job, and for this process, so a child it
 * starts finds the same binaries.
 */
export function addPath(directory) {
  sinks.appendFile(runnerFile('GITHUB_PATH'), `${directory}${EOL}`);
  process.env.PATH = `${directory}${PATH_DELIMITER}${process.env.PATH ?? ''}`;
}
