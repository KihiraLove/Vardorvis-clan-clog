import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canAccessStaffPage,
  defaultModeratorPages,
  parseAccessControl,
  parseStaffPages,
  staffPageForPath,
  staffPages,
} from './staff-pages.js';

test('page access preserves existing moderator defaults and never includes owner tools', () => {
  for (const page of staffPages) {
    assert.equal(
      canAccessStaffPage({ role: 'admin', allowedPages: [] }, page.id),
      true,
    );
    assert.equal(
      canAccessStaffPage({ role: 'moderator' }, page.id),
      defaultModeratorPages.includes(page.id),
    );
    assert.equal(
      canAccessStaffPage({ role: 'moderator', allowedPages: [] }, page.id),
      false,
    );
    assert.equal(staffPageForPath(page.path), page.id);
  }
  assert.equal(staffPageForPath('/admin/xp'), 'schedules');
  assert.equal(staffPageForPath('/admin/access-control'), undefined);
  assert.equal(staffPageForPath('/admin/accounts'), undefined);
});
test('page settings validate known unique pages and canonical ordering, including no access', () => {
  assert.deepEqual(parseStaffPages(['discord', 'submissions']), [
    'submissions',
    'discord',
  ]);
  assert.deepEqual(
    parseAccessControl({ revision: 'access-control-2', moderatorPages: [] }),
    { revision: 'access-control-2', moderatorPages: [] },
  );
  for (const invalid of [
    null,
    {},
    ['accounts'],
    ['access-control'],
    ['submissions', 'submissions'],
    [null],
    ['constructor'],
  ])
    assert.throws(() => parseStaffPages(invalid));
  for (const revision of [
    'access-control-0',
    'settings-1',
    'access-control-1x',
  ])
    assert.throws(() => parseAccessControl({ revision, moderatorPages: [] }));
});
