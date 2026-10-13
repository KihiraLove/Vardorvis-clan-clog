/** Session visibility and access-error classification have no React dependencies. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyAccessFailure,
  visibleAdminSession,
  type AdminAccess,
} from './admin-session.ts';
import type { AdminSession } from './xp-model.ts';

const session: AdminSession = {
  csrfToken: 'csrf',
  displayName: 'Staff',
  username: 'staff',
  role: 'admin',
  mustChangePassword: false,
};
test('only a fully authenticated, configured session reveals private navigation', () => {
  for (const phase of ['checking', 'signed-out', 'expired'] as const)
    assert.equal(visibleAdminSession({ phase }), null);
  assert.equal(
    visibleAdminSession({
      phase: 'authenticated',
      session: { ...session, mustChangePassword: true },
    }),
    null,
  );
  assert.deepEqual(
    visibleAdminSession({ phase: 'authenticated', session }),
    session,
  );
  const moderator: AdminAccess = {
    phase: 'authenticated',
    session: { ...session, role: 'moderator' },
  };
  assert.equal(visibleAdminSession(moderator)?.role, 'moderator');
});

test('a 401 revokes a session, while forbidden business actions preserve login', () => {
  for (const status of [401, 403, 409, 422, 500]) {
    const error = Object.assign(new Error('Private server detail'), { status });
    assert.equal(
      classifyAccessFailure(error),
      status === 401 ? 'expired' : status === 403 ? 'denied' : 'other',
    );
  }
  assert.equal(classifyAccessFailure(new Error('network')), 'other');
  assert.equal(classifyAccessFailure(null), 'other');
  assert.equal(
    classifyAccessFailure({ status: 401 }),
    'other',
    'only genuine client Error objects can drive session revocation',
  );
});
