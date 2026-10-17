import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultRuneLiteRules,
  normalizePlayerName,
  parseRuneLiteRules,
  runeLiteDecision,
} from './runelite-rules.js';
import { blockedRuneLiteWorldTypes } from './world-types.js';

test('world rejection precedes whitelist and combined flags choose the strictest policy', () => {
  const rules = defaultRuneLiteRules('Clan');
  rules.playerWhitelist = ['Trusted_Player'];
  for (const flag of blockedRuneLiteWorldTypes)
    assert.equal(
      runeLiteDecision(['MEMBERS', flag], 'trusted player', rules).action,
      'reject',
    );
  rules.worldPolicies.members = 'allow';
  assert.equal(runeLiteDecision(['MEMBERS'], 'Other', rules).action, 'allow');
  assert.equal(
    runeLiteDecision(['MEMBERS', 'PVP'], 'Other', rules).action,
    'review',
  );
  assert.equal(
    runeLiteDecision(['MEMBERS', 'PVP'], 'trusted player', rules).action,
    'allow',
  );
  for (const flag of ['PVP', 'F2P'] as const) {
    rules.worldPolicies[flag === 'PVP' ? 'pvp' : 'f2p'] = 'reject';
    assert.equal(
      runeLiteDecision(['MEMBERS', flag], 'Trusted_Player', rules).action,
      'reject',
    );
  }
  for (const flag of ['HARDCORE_MAIN']) {
    assert.equal(
      runeLiteDecision([flag, 'MEMBERS'], 'Other', rules).action,
      'review',
    );
    rules.worldPolicies.hardcore = 'allow';
    assert.equal(
      runeLiteDecision([flag, 'MEMBERS'], 'Other', rules).action,
      'allow',
    );
    rules.worldPolicies.hardcore = 'review';
  }
  for (const flags of [[], ['NORMAL'], ['FUTURE_WORLD']]) {
    assert.equal(runeLiteDecision(flags, 'Other', rules).action, 'review');
    assert.equal(
      runeLiteDecision(flags, 'trusted player', rules).action,
      'allow',
    );
  }
});
test('rule validation limits policies and canonicalizes whitelist names without merging distinct players', () => {
  const rules = defaultRuneLiteRules(' In-game Clan ');
  rules.playerWhitelist = [' Player_One ', 'player one', 'Player\u00a0Two'];
  const parsed = parseRuneLiteRules(rules);
  assert.equal(parsed.clanName, 'In-game Clan');
  assert.deepEqual(parsed.playerWhitelist, ['player one', 'Player\u00a0Two']);
  assert.equal(normalizePlayerName('PLAYER_One'), 'player one');
  for (const input of [
    { ...rules, worldPolicies: { ...rules.worldPolicies, members: 'reject' } },
    { ...rules, worldPolicies: { ...rules.worldPolicies, hardcore: 'reject' } },
    { ...rules, worldPolicies: { ...rules.worldPolicies, pvp: 'approved' } },
    { ...rules, worldPolicies: { ...rules.worldPolicies, surprise: 'allow' } },
    { ...rules, matchClanName: 'false' },
    { ...rules, clanName: 'Bad\nClan' },
    { ...rules, clanName: 'a'.repeat(81) },
    { ...rules, surprise: true },
    { ...rules, playerWhitelist: ['___'] },
    { ...rules, playerWhitelist: ['bad\nname'] },
    { ...rules, playerWhitelist: Array.from({ length: 201 }, () => 'Player') },
  ])
    assert.throws(() => parseRuneLiteRules(input));
});
