/** One-shot container initialization: additive migrations, then the pinned first import. */
import { migrate } from './migrate.js';
import { importBundledCatalog } from './catalog-import.js';
import { applyBundledClueTaxonomy } from './clue-taxonomy.js';
import { databaseUrl, readSecret } from './secrets.js';
import {
  provisionRuntimeRole,
  validateRuntimePassword,
} from './runtime-role.js';
const url = databaseUrl();
if (!url) throw new Error('DATABASE_URL is required');
const runtimePassword = validateRuntimePassword(readSecret('APP_DB_PASSWORD'));
await migrate(url);
console.log(
  'Database migrations applied; catalog ' + (await importBundledCatalog(url)),
);

console.log('Clue taxonomy ' + (await applyBundledClueTaxonomy(url)));
await provisionRuntimeRole(url, runtimePassword);
console.log('Restricted database runtime role ready');
