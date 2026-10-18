/** Restore must validate isolation and fresh storage before creating any resources. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const script = resolve(import.meta.dirname, '../infra/restore.sh');
const stub = String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
 'image inspect') printf 'sha256:%064d\n' 1;;
 'run --rm') cat >/dev/null;;
 'compose config') cat "$RESTORE_TEST_ROOT/configuration.json";;
 'compose ps') if [[ "$RESTORE_TEST_FAIL" == container ]]; then printf 'existing-container\n'; fi;;
 'volume inspect') [[ "$RESTORE_TEST_FAIL" == volume ]];;
 'compose up') touch "$RESTORE_TEST_ROOT/created"; exit 50;;
 *) exit 50;;
esac
`;
function exercise(t, change = () => {}, failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'clog-restore-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'backup'));
  const image = 'sha256:' + '0'.repeat(63) + '1';
  writeFileSync(join(root, 'backup', 'COMPLETE'), 'complete\n');
  writeFileSync(
    join(root, 'backup', 'release.json'),
    JSON.stringify({ image, imageId: image }),
  );
  writeFileSync(join(root, 'bin/docker'), stub, { mode: 0o755 });
  const config = {
    services: {
      recovery: {
        environment: { BOT_SETTINGS_MODE: 'disabled' },
        volumes: [{ target: '/data', type: 'volume', source: 'data' }],
        networks: { default: {} },
      },
    },
    volumes: { data: { name: 'unused-target-data' } },
    networks: { default: {} },
  };
  change(config);
  writeFileSync(join(root, 'configuration.json'), JSON.stringify(config));
  const result = spawnSync('bash', [script, join(root, 'backup'), 'recovery'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: join(root, 'bin') + ':' + process.env.PATH,
      COMPOSE_FILE: 'compose.yaml',
      RESTORE_TEST_ROOT: root,
      RESTORE_TEST_FAIL: failure,
    },
  });
  return { result, created: existsSync(join(root, 'created')) };
}
test('isolated fresh service reaches creation without touching other services', (t) => {
  const { created } = exercise(t);
  assert.equal(created, true);
});
const changes = {
  'Discord enabled': (c) =>
    (c.services.recovery.environment.BOT_SETTINGS_MODE = 'database'),
  'published port': (c) =>
    (c.services.recovery.ports = [{ target: 8080, published: '8088' }]),
  'external network': (c) => (c.networks.default.external = true),
  'proxy route': (c) =>
    (c.services.recovery.labels = { 'traefik.enable': 'true' }),
  'additional mount': (c) =>
    c.services.recovery.volumes.push({
      type: 'volume',
      source: 'shared',
      target: '/data/submission-images',
    }),
  'bind mount': (c) => (c.services.recovery.volumes[0].type = 'bind'),
  'external data': (c) => (c.volumes.data.external = true),
};
for (const [name, change] of Object.entries(changes))
  test('restore refuses ' + name + ' before resource creation', (t) => {
    const { created, result } = exercise(t, change);
    assert.equal(created, false, result.stderr);
    assert.notEqual(result.status, 0);
  });
for (const failure of ['container', 'volume'])
  test(
    'restore refuses existing ' + failure + ' before resource creation',
    (t) => {
      const { created, result } = exercise(t, () => {}, failure);
      assert.equal(created, false, result.stderr);
      assert.notEqual(result.status, 0);
    },
  );
