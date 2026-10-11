import assert from 'node:assert/strict';
import test from 'node:test';
import { planCleanup } from './cleanup-images.mjs';

const now = Date.parse('2026-10-11T12:00:00Z');
const version = (name, tags = [], hours = 48) => ({
  id: name,
  name,
  created_at: new Date(now - hours * 3600000).toISOString(),
  updated_at: new Date(now - hours * 3600000).toISOString(),
  metadata: { container: { tags } },
});
test('expires old development images and orphan manifests, retaining only release roots and recent builds', async () => {
  const versions = [
    version('dev', ['sha-old']),
    version('orphan'),
    version('release', ['release-abc', 'sha-abc']),
    version('latest', ['release']),
    version('recent', ['sha-new'], 23),
  ];
  assert.deepEqual(
    (await planCleanup(versions, async () => ({}), now)).map((v) => v.name),
    ['dev', 'orphan'],
  );
});
test('preserves transitive platform and provenance dependencies of retained images', async () => {
  const versions = [
    version('root', ['release-abc']),
    version('platform'),
    version('attestation'),
    version('nested'),
    version('orphan'),
  ];
  const graph = {
    root: { manifests: [{ digest: 'platform' }, { digest: 'attestation' }] },
    attestation: { subject: { digest: 'nested' } },
  };
  assert.deepEqual(
    (await planCleanup(versions, async (d) => graph[d] ?? {}, now)).map(
      (v) => v.name,
    ),
    ['orphan'],
  );
});
test('a recent development index protects older shared dependencies', async () => {
  const versions = [version('new', ['sha-new'], 1), version('shared')];
  assert.deepEqual(
    await planCleanup(
      versions,
      async (d) => (d === 'new' ? { manifests: [{ digest: 'shared' }] } : {}),
      now,
    ),
    [],
  );
});
test('24-hour boundary expires, recently retagged images are retained', async () => {
  const updated = version('updated');
  updated.updated_at = new Date(now).toISOString();
  assert.deepEqual(
    (
      await planCleanup(
        [version('boundary', [], 24), updated],
        async () => ({}),
        now,
      )
    ).map((v) => v.name),
    ['boundary'],
  );
});
test('manifest failures and invalid timestamps abort before deletion', async () => {
  await assert.rejects(
    planCleanup(
      [version('release', ['release'])],
      async () => {
        throw Error('unavailable');
      },
      now,
    ),
    /unavailable/,
  );
  await assert.rejects(
    planCleanup(
      [{ ...version('bad'), created_at: 'invalid' }],
      async () => ({}),
      now,
    ),
    /Invalid timestamps/,
  );
});
