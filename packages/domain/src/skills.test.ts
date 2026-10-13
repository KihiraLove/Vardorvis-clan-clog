import assert from 'node:assert/strict';
import { test } from 'node:test';
import { competitionScope } from './competitions.js';
import { skills, skillIds, skillIcon, skillName } from './skills.js';

test('the shared registry preserves all 24 canonical skills, display order and icon names', () => {
  assert.deepEqual(
    skillIds,
    'attack hitpoints mining strength agility smithing defence herblore fishing ranged thieving cooking prayer crafting firemaking magic fletching woodcutting runecrafting slayer farming construction hunter sailing'.split(
      ' ',
    ),
  );
  for (const [id, name, icon] of skills) {
    assert.equal(skillName(id), name);
    assert.equal(skillIcon(id), '/skills/' + icon);
    assert.equal(icon, (id === 'runecrafting' ? 'runecraft' : id) + '.png');
    assert.deepEqual(competitionScope([id]), { kind: 'SKILL', skills: [id] });
  }
  assert.equal(skillName('runecrafting'), 'Runecraft');
});
test('aggregate and multiple skill scopes use canonical order without counting an aggregate twice', () => {
  for (const aggregate of ['overall', 'total'])
    assert.deepEqual(competitionScope([aggregate]), {
      kind: 'SKILL',
      skills: [...skillIds],
    });
  assert.deepEqual(competitionScope(['fishing', 'attack', 'sailing']), {
    kind: 'SKILL',
    skills: ['attack', 'fishing', 'sailing'],
  });
});
test('non-skill classification is separate from validating supported result data', () => {
  for (const metric of [
    'vardorvis',
    'clue_scrolls_all',
    'ehp',
    'unknown_metric',
  ])
    assert.deepEqual(competitionScope([metric]), {
      kind: 'ACTIVITY',
      skills: [],
    });
  for (const scope of [
    [],
    ['attack', 'attack'],
    ['overall', 'attack'],
    ['total', 'overall'],
    ['attack', 'vardorvis'],
    ['attack', 'ehp'],
    ['vardorvis', 'zulrah'],
  ])
    assert.throws(() => competitionScope(scope), /Invalid|unsupported/);
});
