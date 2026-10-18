import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const script = resolve(import.meta.dirname, '../infra/backup.sh');
const stub = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BACKUP_TEST_ROOT/operations.log"
case "$1 $2" in
 'compose config') printf '{"services":{"website":{}}}\n';;
 'compose ps') [[ "$BACKUP_TEST_FAIL" != inventory ]] || exit 50; printf 'selected-container\n';;
 'inspect --format')
  if [[ "$3" == *io.clog.service* ]]; then
    if [[ "$BACKUP_TEST_FAIL" == label ]]; then printf 'unrelated\n'; else printf 'installation\n'; fi
  elif [[ "$3" == *compose.project* ]]; then printf 'shared-services\n';
  else printf 'sha256:%064d\n' 1; fi;;
 'image inspect') if [[ "$*" != *RepoDigests* ]]; then printf 'sha256:%064d\n' 1; fi;;
 'exec --user') [[ "$BACKUP_TEST_FAIL" != capture ]] || exit 50; tar -C "$BACKUP_TEST_ROOT/payload" -czf - .;;
 'run --rm')
  [[ "$BACKUP_TEST_FAIL" != readiness ]] || exit 50
  directory="$BACKUP_TEST_ROOT/verify"
  mkdir "$directory"
  tar -xzf - -C "$directory"
  (cd "$directory" && sha256sum --check SHA256SUMS && sha256sum --check META-SHA256SUMS) >/dev/null;;
 *) exit 50;;
esac
`;
function exercise(t, failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'clog-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'payload'));
  writeFileSync(join(root, 'bin/docker'), stub, { mode: 0o755 });
  const payload = join(root, 'payload');
  for (const name of [
    'database.dump',
    'icons.tar.gz',
    'screenshots.tar.gz',
    'secrets.tar.gz',
    'configuration.json',
  ])
    writeFileSync(join(payload, name), name);
  writeFileSync(
    join(payload, 'release.json'),
    JSON.stringify({ format: 2, revision: 'a'.repeat(40) }),
  );
  writeFileSync(join(payload, 'schema.json'), '{}');
  writeFileSync(join(payload, 'COMPLETE'), 'complete\n');
  writeFileSync(
    join(payload, 'SHA256SUMS'),
    execFileSync(
      'sha256sum',
      [
        'database.dump',
        'icons.tar.gz',
        'screenshots.tar.gz',
        'secrets.tar.gz',
        'configuration.json',
      ],
      { cwd: payload },
    ),
  );
  if (failure === 'checksum')
    writeFileSync(join(payload, 'database.dump'), 'corrupt');
  const target = join(root, 'backup');
  const result = spawnSync('bash', [script, target, 'website'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: join(root, 'bin') + ':' + process.env.PATH,
      COMPOSE_FILE: 'compose.yaml',
      BACKUP_TEST_ROOT: root,
      BACKUP_TEST_FAIL: failure,
    },
  });
  return {
    target,
    result,
    log: readFileSync(join(root, 'operations.log'), 'utf8'),
  };
}
test('backup selects one installation in a shared project and records the actual image/service', (t) => {
  const { result, target, log } = exercise(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(target, 'COMPLETE'), 'utf8'), 'complete\n');
  const record = JSON.parse(readFileSync(join(target, 'release.json'), 'utf8'));
  assert.equal(record.service, 'website');
  assert.equal(record.project, 'shared-services');
  assert.match(record.image, /^sha256:/u);
  assert.match(log, /compose ps --all -q website/u);
  assert.match(log, /exec --user 0 selected-container clog backup/u);
  assert.doesNotMatch(
    log,
    /compose (stop|down|start)|\b(db|migrate|sidecar)\b/u,
  );
});
for (const failure of [
  'inventory',
  'label',
  'capture',
  'checksum',
  'readiness',
])
  test('backup failure ' + failure + ' cannot publish COMPLETE', (t) => {
    const { result, target, log } = exercise(t, failure);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(target, 'COMPLETE')), false);
    assert.doesNotMatch(log, /compose (stop|down|start)/u);
  });
