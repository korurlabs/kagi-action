import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extractRegularFile } from '../src/tar.js';
import { ActionError } from '../src/core.js';
import { paxData, tarArchive, tarEntry } from './helpers.js';

describe('extractRegularFile', () => {
  test('takes the kagi binary and ignores the other entries', () => {
    const archive = tarArchive([
      { name: 'LICENSE', data: 'MIT' },
      { name: 'README.md', data: 'x'.repeat(1000) },
      { name: 'kagi', data: 'binary-bytes', mode: 0o755 },
    ]);
    assert.equal(extractRegularFile(archive, 'kagi').toString(), 'binary-bytes');
  });

  test('reads a ./kagi name, a ustar prefix and a PAX path', () => {
    assert.equal(extractRegularFile(tarArchive([{ name: './kagi', data: 'a' }]), 'kagi').toString(), 'a');
    // A name that only becomes "kagi" after the prefix is joined is not the top-level kagi.
    assert.throws(() => extractRegularFile(tarArchive([{ name: 'kagi', prefix: 'bin', data: 'b' }]), 'kagi'), /holds no kagi/);
    const pax = tarArchive([
      { name: 'PaxHeaders/x', type: 'x', data: paxData({ path: 'kagi' }) },
      { name: 'something-else', data: 'c' },
    ]);
    assert.equal(extractRegularFile(pax, 'kagi').toString(), 'c');
  });

  test('a PAX path applies to the next entry only', () => {
    const archive = tarArchive([
      { name: 'PaxHeaders/x', type: 'x', data: paxData({ path: 'not-kagi' }) },
      { name: 'kagi', data: 'renamed away' },
      { name: 'kagi', data: 'the real one' },
    ]);
    assert.equal(extractRegularFile(archive, 'kagi').toString(), 'the real one');
  });

  test('refuses kagi as a symbolic link, a hard link or a directory', () => {
    for (const [type, word] of [['2', 'symbolic link'], ['1', 'hard link'], ['5', 'directory']]) {
      const archive = tarArchive([{ name: 'kagi', type, linkname: '/bin/sh' }]);
      assert.throws(() => extractRegularFile(archive, 'kagi'), new RegExp(word), word);
    }
  });

  test('refuses an archive without kagi, or with kagi twice', () => {
    assert.throws(() => extractRegularFile(tarArchive([{ name: 'README.md', data: 'x' }]), 'kagi'), /holds no kagi binary/);
    const twice = tarArchive([
      { name: 'kagi', data: 'one' },
      { name: './kagi', data: 'two' },
    ]);
    assert.throws(() => extractRegularFile(twice, 'kagi'), /more than once/);
  });

  test('refuses a corrupt header and a truncated archive', () => {
    const corrupt = tarArchive([{ name: 'kagi', data: 'x' }]);
    corrupt[0] = 'K'.charCodeAt(0);
    assert.throws(() => extractRegularFile(corrupt, 'kagi'), /corrupt header/);
    const entry = tarEntry({ name: 'kagi', data: 'y'.repeat(2000) });
    assert.throws(() => extractRegularFile(entry.subarray(0, 1024), 'kagi'), (error) => error instanceof ActionError && /truncated/.test(error.message));
  });

  test('reads an archive made by the system tar, like the release archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagi-action-tar-'));
    writeFileSync(join(dir, 'LICENSE'), 'MIT');
    writeFileSync(join(dir, 'README.md'), '# kagi');
    writeFileSync(join(dir, 'kagi'), 'system-tar-binary');
    chmodSync(join(dir, 'kagi'), 0o755);
    const archivePath = join(dir, 'archive.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', dir, 'LICENSE', 'README.md', 'kagi']);
    const tarball = gunzipSync(readFileSync(archivePath));
    assert.equal(extractRegularFile(tarball, 'kagi').toString(), 'system-tar-binary');
  });
});
