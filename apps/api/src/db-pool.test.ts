import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { classifyPoolFailure, observePoolFailures } from './db-pool.js';

test('idle pool errors are consumed, categorized and never disclose the driver error', async () => {
  const pool = new pg.Pool();
  const categories: string[] = [];
  observePoolFailures(pool, (category) => categories.push(category));
  const unsafe = Object.assign(
    new Error('private-password SQL parameter: do not log this'),
    { code: 'ECONNRESET', connectionString: 'postgresql://secret@db/clog' },
  );
  assert.equal(pool.emit('error', unsafe), true);
  assert.deepEqual(categories, ['connection-lost']);
  assert.equal(JSON.stringify(categories).includes('private-password'), false);
  assert.equal(JSON.stringify(categories).includes('secret'), false);
  await pool.end();
});

test('pool error categories are stable, allowlisted and do not interpolate unsafe properties', () => {
  const cases: [unknown, string][] = [
    [{ code: '57P01' }, 'database-shutdown'],
    [{ code: '57P02' }, 'database-shutdown'],
    [{ code: '57P03' }, 'database-shutdown'],
    [{ code: '08006' }, 'connection-lost'],
    [{ code: '08P01' }, 'connection-lost'],
    [{ code: 'EPIPE' }, 'connection-lost'],
    [{ code: 'ECONNREFUSED' }, 'connection-refused'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: '23505' }, 'unknown'],
    [{ code: 'secret-connection-string' }, 'unknown'],
    [new Error('connection details with password'), 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [error, expected] of cases)
    assert.equal(classifyPoolFailure(error), expected);
});
