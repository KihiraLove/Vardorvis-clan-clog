import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration, main } from './check-local.mjs';

test('local acceptance isolates concurrent runs and ignores production environment values', () => {
  const original = process.env.POSTGRES_PASSWORD;
  process.env.POSTGRES_PASSWORD = 'production-must-not-be-used';
  try {
    const first = configuration('clog-checks-first');
    const second = configuration('clog-checks-second');
    const url = new URL(first.env.TEST_DATABASE_URL);
    assert.equal(url.hostname, first.database);
    assert.equal(url.pathname, '/clog_test');
    assert.notEqual(url.password, process.env.POSTGRES_PASSWORD);
    assert.equal(first.env.COMPOSE_PROJECT_NAME, first.id);
    assert.equal(first.env.CHECK_NETWORK, first.network);
    assert.equal(first.env.COMPOSE_DISABLE_ENV_FILE, 'true');
    assert.equal(first.env.BOT_ENABLED, 'false');
    assert.equal(first.env.DISCORD_BOT_TOKEN, '');
    for (const key of [
      'network',
      'database',
      'runner',
      'appImage',
      'runnerImage',
    ])
      assert.notEqual(first[key], second[key]);
    assert.equal(
      new Set([
        first.env.POSTGRES_PASSWORD,
        first.env.APP_DB_PASSWORD,
        first.env.SESSION_SECRET,
        first.env.ADMIN_BOOTSTRAP_PASSWORD,
      ]).size,
      4,
    );
  } finally {
    if (original === undefined) delete process.env.POSTGRES_PASSWORD;
    else process.env.POSTGRES_PASSWORD = original;
  }
});

test('invalid cleanup scopes and unknown arguments fail before touching Docker', async () => {
  for (const id of [
    'clan-clog',
    '',
    'clog-checks-',
    'clog-checks-a/../../prod',
    'clog-checks-A',
  ])
    assert.throws(() => configuration(id), /Invalid disposable project/);
  await assert.rejects(main(['--skip-database']), /Unknown arguments/);
});
