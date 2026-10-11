/** Fresh private response fixtures prevent mutations from leaking between test cases. */
import { PreviewAdminClient } from '../src/preview/admin.ts';
export async function adminFixtures() {
  const client = new PreviewAdminClient(),
    signal = new AbortController().signal;
  return {
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
