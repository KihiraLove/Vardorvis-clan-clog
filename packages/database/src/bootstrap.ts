/** One-shot container initialization: additive migrations, then the pinned first import. */
import { migrate } from './migrate.js';
import { importBundledCatalog } from './catalog-import.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await migrate(url);
console.log(
  'Database migrations applied; catalog ' + (await importBundledCatalog(url)),
);
