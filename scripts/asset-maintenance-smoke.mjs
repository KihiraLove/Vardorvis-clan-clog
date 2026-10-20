import { databaseUrl as runtimeDatabaseUrl } from '@clog/database/dist/secrets.js';
/** Disposable production-volume acceptance; never run against clan data. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
if (process.env.ASSET_SMOKE_DISPOSABLE !== 'true')
  throw new Error('Disposable stack only.');
const pool = new pg.Pool({
  connectionString: runtimeDatabaseUrl(
    process.env,
    process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
  ),
});
const dirs = {
  icons: process.env.ICON_STORAGE_PATH,
  branding: join(process.env.ICON_STORAGE_PATH, 'branding'),
  proofs: process.env.PROOF_STORAGE_PATH,
};
const stateFile = '/tmp/asset-maintenance-smoke.json';
try {
  if (process.argv[2] === 'seed') {
    const old = new Date(Date.now() - 72 * 3600000);
    const retained = [];
    for (const [query, kind, suffix] of [
      [
        'SELECT id FROM catalog_assets WHERE item_id IS NOT NULL',
        'icons',
        '.webp',
      ],
      ['SELECT id FROM clan_logo_assets', 'branding', '.webp'],
      ['SELECT favicon_id AS id FROM clan_logo_assets', 'branding', '.webp'],
      ['SELECT id FROM submission_images', 'proofs', '.webp'],
    ]) {
      const rows = (await pool.query(query)).rows;
      assert.ok(
        rows.length < 100,
        'Only small disposable fixtures are supported',
      );
      for (const row of rows) {
        const file = join(dirs[kind], row.id + suffix);
        await utimes(file, old, old);
        retained.push(file);
      }
    }
    const orphans = [
      join(dirs.icons, randomUUID() + '.webp'),
      join(dirs.branding, randomUUID() + '.webp'),
      join(dirs.proofs, randomUUID() + '.webp'),
    ];
    for (const file of orphans) {
      await writeFile(file, 'abandoned-upload');
      await utimes(file, old, old);
    }
    const fresh = join(dirs.proofs, randomUUID() + '.webp');
    await writeFile(fresh, 'active-upload');
    const rootPath = join(dirs.proofs, '.clan-api-key.secret');
    const rootHash = createHash('sha256')
      .update(await readFile(rootPath))
      .digest('hex');
    const rights = (
      await pool.query(
        "SELECT has_table_privilege(current_user,'asset_retirements','SELECT') AS read,has_table_privilege(current_user,'asset_retirements','INSERT') AS insert,has_table_privilege(current_user,'asset_retirements','UPDATE') AS update,has_table_privilege(current_user,'asset_retirements','DELETE') AS delete",
      )
    ).rows[0];
    assert.deepEqual(rights, {
      read: true,
      insert: false,
      update: false,
      delete: false,
    });
    await writeFile(
      stateFile,
      JSON.stringify({ retained, orphans, fresh, rootPath, rootHash }),
      { mode: 0o600 },
    );
    console.log(
      'Prepared retired-upload fixtures and aged current/historical references.',
    );
  } else if (process.argv[2] === 'verify') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const file of state.retained)
      assert.ok((await readFile(file)).length > 0);
    for (const file of state.orphans)
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(state.fresh, 'utf8'), 'active-upload');
    assert.equal(
      createHash('sha256')
        .update(await readFile(state.rootPath))
        .digest('hex'),
      state.rootHash,
    );
    console.log(
      'Asset maintenance preserves references, fresh uploads and encryption root.',
    );
  } else throw new Error('Use seed or verify.');
} finally {
  await pool.end();
}
