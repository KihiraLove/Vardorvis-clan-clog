import { databaseUrl as runtimeDatabaseUrl } from '@clog/database/dist/secrets.js';
/** Run inside a disposable app: complete state fingerprints and semantic recovery checks. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { ProofStorage } from './apps/api/dist/proof-storage.js';
import { PasswordHasher } from './apps/api/dist/passwords.js';
import {
  PgClanKeyStore,
  loadClanKeyRoot,
} from './apps/api/dist/clan-api-key.js';
if (process.env.RECOVERY_DISPOSABLE !== 'true')
  throw new Error('Disposable recovery stack required');
const pool = new pg.Pool({
  connectionString: runtimeDatabaseUrl(
    process.env,
    process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
  ),
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(directory, prefix = '') {
  const output = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = path.join(prefix, entry.name),
      target = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Unexpected asset link');
    if (entry.isDirectory()) Object.assign(output, await files(target, name));
    else output[name] = hash(await readFile(target));
  }
  return output;
}
try {
  if (process.argv[2] === 'seed') {
    const owner = (
      await pool.query("SELECT id FROM staff_accounts WHERE role='admin'")
    ).rows[0].id;
    const passwords = new PasswordHasher(),
      account = randomUUID();
    try {
      await pool.query(
        "INSERT INTO staff_accounts(id,username,role,password_hash,must_change_password) VALUES($1,'recovery-moderator','moderator',$2,false)",
        [account, await passwords.hash('recovery-only-moderator-password')],
      );
      await pool.query(
        "INSERT INTO staff_account_audit(actor_id,account_id,action,username) VALUES($1,$2,'create','recovery-moderator')",
        [owner, account],
      );
    } finally {
      await passwords.close();
    }
    const storage = new ProofStorage(process.env.PROOF_STORAGE_PATH);
    const image = await storage.save(
      await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#22aaff' },
      })
        .png()
        .toBuffer(),
      'image/png',
    );
    await pool.query(
      'INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,$2,$3,$4,$5)',
      [image.id, image.sha256, image.byteSize, image.width, image.height],
    );
    const item = (
      await pool.query(
        "SELECT id FROM items WHERE icon_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.item_id=items.id AND s.status='approved') LIMIT 1",
      )
    ).rows[0].id;
    const submission = randomUUID();
    await pool.query(
      "INSERT INTO submissions(id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,source,proof_image_id,status,reviewed_at,reviewed_by) VALUES($1,'Recovery manual trophy',$2,'Recovery fixture','2026-10-01','admin','','manual',$3,'approved',now(),$4)",
      [submission, item, image.id, owner],
    );
    await pool.query(
      "INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,old_values,new_values,reason) VALUES($1,$2,'Recovery owner','approve','{}','{\"status\":\"approved\"}','Recovery acceptance')",
      [submission, owner],
    );
    console.log(
      'Representative moderator, credit, audit and private screenshot added.',
    );
  } else if (process.argv[2] === 'snapshot') {
    const tables = {};
    for (const { tablename } of (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows) {
      assert.match(tablename, /^[a-z_]+$/);
      tables[tablename] = (
        await pool.query(
          `SELECT count(*)::int AS rows,md5(coalesce(string_agg(row::text,E'\\n' ORDER BY row::text),'')) AS hash FROM (SELECT to_jsonb(t) AS row FROM "${tablename}" t) records`,
        )
      ).rows[0];
    }
    for (const table of [
      'staff_accounts',
      'submissions',
      'audit_events',
      'xp_events',
      'xp_import_history',
      'competition_import_history',
      'collection_log_schedules',
      'catalog_audit',
      'catalog_requests',
      'catalog_assets',
      'clan_logo_assets',
      'submission_images',
      'clan_api_keys',
    ])
      assert.ok(
        tables[table]?.rows > 0,
        'Missing representative table: ' + table,
      );
    assert.ok(tables.staff_accounts.rows >= 2);
    assert.ok(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM collection_credits',
        )
      ).rows[0].count > 0,
    );
    console.log(
      JSON.stringify({
        tables,
        icons: await files(process.env.ICON_STORAGE_PATH),
        proofs: await files(process.env.PROOF_STORAGE_PATH),
      }),
    );
  } else if (process.argv[2] === 'verify') {
    const keyStore = new PgClanKeyStore(
      pool,
      await loadClanKeyRoot(process.env.PROOF_STORAGE_PATH),
    );
    const key = await keyStore.settings();
    assert.equal(
      hash(key.key),
      (await pool.query('SELECT key_hash FROM clan_api_keys')).rows[0].key_hash,
    );
    const origin = process.env.PUBLIC_ORIGIN,
      url = 'http://127.0.0.1:8080';
    const response = await fetch(url + '/api/v1/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'ci-only-test-admin-password',
      }),
    });
    assert.equal(response.status, 200, 'Restored owner login');
    const headers = {
      Cookie: response.headers.get('set-cookie').split(';')[0],
    };
    const moderator = await fetch(url + '/api/v1/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'recovery-moderator',
        password: 'recovery-only-moderator-password',
      }),
    });
    assert.equal(moderator.status, 200, 'Restored moderator login');
    assert.equal(
      (
        await fetch(url + '/api/v1/admin/diagnostics', {
          headers: {
            Cookie: moderator.headers.get('set-cookie').split(';')[0],
          },
        })
      ).status,
      403,
    );
    const proof = (
      await pool.query(
        "SELECT * FROM submission_images WHERE id IN (SELECT proof_image_id FROM submissions WHERE collector_name='Recovery fixture')",
      )
    ).rows[0];
    const proofPath = '/api/v1/admin/submission-images/' + proof.id + '.png';
    assert.equal((await fetch(url + proofPath)).status, 401);
    const image = await fetch(url + proofPath, { headers });
    assert.equal(image.status, 200);
    assert.equal(hash(Buffer.from(await image.arrayBuffer())), proof.sha256);
    for (const { id, sha256 } of (
      await pool.query(
        'SELECT id,sha256 FROM catalog_assets WHERE item_id IS NOT NULL',
      )
    ).rows) {
      const asset = await fetch(url + '/api/v1/catalog/icons/' + id + '.png');
      assert.equal(asset.status, 200);
      assert.equal(hash(Buffer.from(await asset.arrayBuffer())), sha256);
    }
    for (const { id, sha256, favicon_sha256 } of (
      await pool.query('SELECT id,sha256,favicon_sha256 FROM clan_logo_assets')
    ).rows) {
      for (const [suffix, expected] of [
        ['.webp', sha256],
        ['/favicon.png', favicon_sha256],
      ]) {
        const asset = await fetch(url + '/api/v1/branding/' + id + suffix);
        assert.equal(asset.status, 200);
        assert.equal(hash(Buffer.from(await asset.arrayBuffer())), expected);
      }
    }
    const rootPath = path.join(
        process.env.PROOF_STORAGE_PATH,
        '.clan-api-key.secret',
      ),
      root = await readFile(rootPath),
      before = (
        await pool.query('SELECT encrypted_key,key_hash FROM clan_api_keys')
      ).rows;
    try {
      await writeFile(rootPath, randomBytes(32));
      await assert.rejects(
        new PgClanKeyStore(
          pool,
          await loadClanKeyRoot(process.env.PROOF_STORAGE_PATH),
        ).ensureDefault(),
      );
      await unlink(rootPath);
      await assert.rejects(
        new PgClanKeyStore(
          pool,
          await loadClanKeyRoot(process.env.PROOF_STORAGE_PATH),
        ).ensureDefault(),
      );
      assert.deepEqual(
        (await pool.query('SELECT encrypted_key,key_hash FROM clan_api_keys'))
          .rows,
        before,
      );
    } finally {
      await writeFile(rootPath, root, { mode: 0o600 });
    }
    assert.equal(hash((await keyStore.settings()).key), hash(key.key));
    assert.deepEqual(
      (
        await pool.query(
          "SELECT current_user AS role,has_table_privilege(current_user,'audit_events','UPDATE') AS rewrite,has_table_privilege(current_user,'schema_migrations','SELECT') AS schema",
        )
      ).rows[0],
      { role: 'clog_runtime', rewrite: false, schema: false },
    );
    console.log(
      'Restored owner/moderator login, grants, icon/logo/proof bytes, private access and clan-key decryption passed; wrong/missing roots fail without replacing encrypted keys.',
    );
  } else if (process.argv[2] === 'old-credentials') {
    const oldUrl = new URL(
      runtimeDatabaseUrl(
        process.env,
        process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
      ),
    );
    oldUrl.password = process.env.RECOVERY_OLD_PASSWORD;
    const old = new pg.Client({
      connectionString: oldUrl.href,
      connectionTimeoutMillis: 3000,
    });
    await assert.rejects(old.connect(), { code: '28P01' });
    await old.end();
    assert.equal(
      (await pool.query('SELECT current_user AS role')).rows[0].role,
      'clog_runtime',
    );
    console.log(
      'Old runtime credentials rejected; new restricted connection succeeds.',
    );
  } else throw new Error('Unknown recovery state mode');
} finally {
  await pool.end();
}
