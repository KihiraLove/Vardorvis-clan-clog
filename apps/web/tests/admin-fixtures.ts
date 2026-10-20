/** Fresh private response fixtures prevent mutations from leaking between test cases. */
import { MemoryAdminClient } from './support/admin.ts';
export async function adminFixtures() {
  const client = new MemoryAdminClient(),
    signal = new AbortController().signal;
  return {
    catalogUpdates: {
      revision: '0'.repeat(64),
      catalogRevision: 'catalog-1',
      autoOpen: false,
      releases: [],
      proposals: [],
      conflicts: [],
      currentImages: [],
    },
    catalog: await client.catalog(signal),
    pending: await client.queue('pending', undefined, signal),
    unmatched: await client.queue('unmatched', undefined, signal),
    reviewed: await client.queue('reviewed', undefined, signal),
    detail: await client.detail('sample-hardcore', signal),
    session: {
      authenticated: true,
      displayName: 'KihiraVD',
      csrfToken: 'csrf-test',
      username: 'KihiraVD',
      role: 'admin',
      mustChangePassword: false,
    },
  };
}
