import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, '../infra/backup.sh');

// Stub only the Compose boundary; use real tar and checksums to detect corrupt archives.
// Each test owns a separate sandbox and a separate fake writer state.
const dockerStub = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BACKUP_TEST_LOG"
[[ "$1" == compose ]] || exit 50
shift
case "$1" in
  ps)
    if [[ "\${BACKUP_TEST_FAIL:-}" == inventory || ( "\${BACKUP_TEST_FAIL:-}" == verify-stop && -e "$BACKUP_TEST_STATE/stopped" ) || ( "\${BACKUP_TEST_FAIL:-}" == final-inventory && -e "$BACKUP_TEST_STATE/captured" ) || ( "\${BACKUP_TEST_FAIL:-}" == verify-restart && -e "$BACKUP_TEST_STATE/restarted" ) ]]; then exit 50; fi
    if [[ "\${BACKUP_TEST_FAIL:-}" == no-db ]]; then printf 'app\n'; exit 0; fi
    if [[ "\${BACKUP_TEST_FAIL:-}" == migrate ]]; then printf 'db\nmigrate\n'; exit 0; fi
    if [[ "\${BACKUP_TEST_FAIL:-}" == unknown ]]; then printf 'db\napp\nsidecar\n'; exit 0; fi
    if [[ "\${BACKUP_TEST_FAIL:-}" == duplicate ]]; then printf 'db\napp\napp\n'; exit 0; fi
    printf 'db\n'
    if [[ ! -e "$BACKUP_TEST_STATE/stopped" || -e "$BACKUP_TEST_STATE/restarted" || "\${BACKUP_TEST_FAIL:-}" == still-running ]]; then
      if [[ "\${BACKUP_TEST_OFFLINE:-}" != 1 ]]; then printf 'app\n'; fi
    fi
    ;;
  stop)
    touch "$BACKUP_TEST_STATE/stopped"
    [[ "\${BACKUP_TEST_FAIL:-}" != stop ]] || exit 50
    ;;
  start)
    [[ "\${BACKUP_TEST_FAIL:-}" != restart ]] || exit 50
    touch "$BACKUP_TEST_STATE/restarted"
    ;;
  exec)
    [[ "\${BACKUP_TEST_FAIL:-}" != dump ]] || exit 50
    printf 'PGDMP simulated custom dump\n'
    ;;
  run)
    if [[ "$*" == *'--entrypoint tar'* ]]; then
      [[ "\${BACKUP_TEST_FAIL:-}" != icons ]] || exit 50
      tar -C "$BACKUP_TEST_STATE/icons" -czf - .
    elif [[ "$*" == *'--entrypoint sh'* ]]; then
      [[ "\${BACKUP_TEST_FAIL:-}" != screenshots ]] || exit 50
      tar -C "$BACKUP_TEST_STATE/screenshots" -czf - .
      touch "$BACKUP_TEST_STATE/captured"
    else exit 50; fi
    ;;
  *) exit 50 ;;
esac
`.replaceAll('\\${', '${');

function exercise(t, failure = '', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clog-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  mkdirSync(join(state, 'icons'), { recursive: true });
  mkdirSync(join(state, 'screenshots'), { recursive: true });
  writeFileSync(join(state, 'icons', 'example.png'), 'image');
  writeFileSync(join(state, 'screenshots', '.clan-api-key.secret'), 'secret');
  writeFileSync(join(state, 'screenshots', 'example.png'), 'proof');
  writeFileSync(join(root, '.current-release'), 'sha-test-release\n');
  writeFileSync(join(bin, 'docker'), dockerStub, { mode: 0o755 });
  writeFileSync(
    join(bin, 'flock'),
    `#!/bin/sh\nif [ "$BACKUP_TEST_FAIL" = lock ]; then exit 50; fi\nexec /usr/bin/flock "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'sha256sum'),
    `#!/bin/sh\nif [ "$BACKUP_TEST_FAIL" = checksum ] || { [ "$BACKUP_TEST_FAIL" = checksum-check ] && [ "$1" = --check ]; }; then exit 50; fi\nexec /usr/bin/sha256sum "$@"\n`,
    { mode: 0o755 },
  );
  const target = join(root, 'backup');
  const result = spawnSync('bash', [script, target], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BACKUP_TEST_FAIL: failure,
      BACKUP_TEST_STATE: state,
      BACKUP_TEST_LOG: join(root, 'operations.log'),
      BACKUP_TEST_OFFLINE: options.offline ? '1' : '',
    },
    encoding: 'utf8',
  });
  const log = existsSync(join(root, 'operations.log'))
    ? readFileSync(join(root, 'operations.log'), 'utf8')
    : '';
  return { result, log, target };
}

test('backup captures encryption root and restarts the writer', (t) => {
  const { result, log, target } = exercise(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(target, 'COMPLETE'), 'utf8'), 'complete\n');
  execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: target });
  assert.match(
    execFileSync('tar', ['-tzf', join(target, 'screenshots.tar.gz')], {
      encoding: 'utf8',
    }),
    /\.clan-api-key\.secret/,
  );
  assert.match(
    execFileSync('tar', ['-tzf', join(target, 'icons.tar.gz')], {
      encoding: 'utf8',
    }),
    /example\.png/,
  );
  assert.equal(
    readFileSync(join(target, 'release.txt'), 'utf8'),
    'sha-test-release\n',
  );
  assert.ok(log.indexOf('stop app') < log.indexOf('exec -T db pg_dump'));
  assert.ok(log.indexOf('start app') > log.indexOf('--entrypoint sh'));
});

test('an initially offline app is never started by backup', (t) => {
  const { result, log, target } = exercise(t, '', { offline: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(target, 'COMPLETE')));
  assert.doesNotMatch(log, /stop app|start app/);
});

const faultStages = [
  'inventory',
  'no-db',
  'migrate',
  'unknown',
  'duplicate',
  'stop',
  'still-running',
  'verify-stop',
  'dump',
  'icons',
  'screenshots',
  'final-inventory',
  'checksum',
  'checksum-check',
  'restart',
  'verify-restart',
  'lock',
];

for (const stage of faultStages) {
  test(`failure injection: ${stage} cannot publish COMPLETE`, (t) => {
    const { result, log, target } = exercise(t, stage);
    assert.notEqual(result.status, 0, `${stage} unexpectedly succeeded`);
    assert.equal(existsSync(join(target, 'COMPLETE')), false);
    if (
      ['inventory', 'no-db', 'migrate', 'unknown', 'duplicate', 'lock'].includes(
        stage,
      )
    ) {
      assert.doesNotMatch(log, /stop app|start app/);
    } else {
      assert.match(log, /start app/, `${stage} should restore the writer`);
    }
    if (['restart', 'verify-restart'].includes(stage)) {
      assert.match(result.stderr, /BACKUP RESTART FAILED/);
    }
    if (stage === 'lock') assert.equal(log, '');
  });
}
