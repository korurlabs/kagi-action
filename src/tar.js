/**
 * Reads one regular file out of an uncompressed tar archive, in memory.
 *
 * Only the named file is taken and nothing is written while the archive is read, so no entry can
 * place a file anywhere: there are no paths to sanitise and no links to follow. The reader handles
 * the forms Go's archive/tar writes (POSIX ustar with its name prefix, PAX extended headers) and
 * GNU long names, which is enough for the archives the Kagi CLI release ships.
 */

import { ActionError } from './core.js';

const BLOCK = 512;

const TYPE_NAMES = {
  1: 'hard link',
  2: 'symbolic link',
  3: 'character device',
  4: 'block device',
  5: 'directory',
  6: 'FIFO',
};

function cString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function parseOctal(bytes, field) {
  if (bytes[0] & 0x80) {
    // Base-256 numbers only appear for sizes above 8 GiB, far beyond any CLI archive.
    throw new ActionError(`The Kagi CLI archive has a header ${field} this action does not read.`);
  }
  const text = cString(bytes).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new ActionError(`The Kagi CLI archive has a malformed header ${field}.`);
  }
  return text === '' ? 0 : parseInt(text, 8);
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** The header checksum is the byte sum with its own 8-byte field read as spaces. */
function checkHeaderSum(header) {
  const recorded = parseOctal(header.subarray(148, 156), 'checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (sum !== recorded) {
    throw new ActionError('The Kagi CLI archive has a corrupt header.');
  }
}

/** POSIX ustar splits a long name into prefix and name; GNU tar uses those bytes for times. */
function headerName(header) {
  const name = cString(header.subarray(0, 100));
  const isPosixUstar = header.subarray(257, 263).toString('latin1') === 'ustar\0';
  const prefix = isPosixUstar ? cString(header.subarray(345, 500)) : '';
  return prefix ? `${prefix}/${name}` : name;
}

/** PAX records are "<length> <key>=<value>\n"; only path and size matter here. */
function parsePax(data) {
  const records = {};
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number(data.subarray(position, space).toString('latin1'));
    if (!Number.isInteger(length) || length <= 0 || position + length > data.length) {
      throw new ActionError('The Kagi CLI archive has a malformed PAX header.');
    }
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    position += length;
  }
  const overrides = {};
  if (records.path !== undefined) overrides.path = records.path;
  if (records.size !== undefined) {
    const size = Number(records.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ActionError('The Kagi CLI archive has a malformed PAX size.');
    }
    overrides.size = size;
  }
  return overrides;
}

function normalizeName(name) {
  let normalized = name;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/**
 * Returns the content of the regular file named `wanted` at the top of the archive. Refuses an
 * archive where that name is missing, is anything but a regular file, or appears more than once,
 * because each of those means the archive is not the release this action expects.
 */
export function extractRegularFile(archive, wanted) {
  let offset = 0;
  let overrides = {};
  let found = null;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    checkHeaderSum(header);

    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = overrides.size ?? parseOctal(header.subarray(124, 136), 'size');
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new ActionError('The Kagi CLI archive is truncated.');
    }
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      overrides = { ...overrides, ...parsePax(data) };
      continue;
    }
    if (type === 'L') {
      overrides = { ...overrides, path: cString(data) };
      continue;
    }
    if (type === 'g' || type === 'K') {
      // A PAX global header or a GNU long link name describes no file of its own.
      continue;
    }

    const name = normalizeName(overrides.path ?? headerName(header));
    overrides = {};
    if (name !== wanted) continue;

    if (type !== '0' && type !== '7') {
      throw new ActionError(
        `The Kagi CLI archive holds ${wanted} as a ${TYPE_NAMES[type] ?? `type '${type}' entry`}, ` +
          'not as a regular file, so it was not installed.'
      );
    }
    if (found) {
      throw new ActionError(`The Kagi CLI archive holds ${wanted} more than once, so it was not installed.`);
    }
    found = Buffer.from(data);
  }

  if (!found) {
    throw new ActionError(`The Kagi CLI archive holds no ${wanted} binary.`);
  }
  return found;
}
