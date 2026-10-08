/** Wire-shaped fixtures distinguish positive, zero and unavailable participant gains. */
import {
  zeroTotals,
  type ImportPreview,
  type SkillId,
} from '../src/xp-model.ts';

export const competition = {
  id: 1001,
  title: 'Vardorvis Attack week',
  sourceUrl: 'https://wiseoldman.net/competitions/1001',
  skills: ['attack'] as SkillId[],
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-10-08T00:00:00Z',
  importedAt: '2026-10-05T12:00:00Z',
};
export const participants = [
  { playerId: 1, displayName: 'KihiraVD', gains: { attack: '12345678' } },
  { playerId: 2, displayName: 'Oakheart', gains: { attack: '6000000' } },
  { playerId: 3, displayName: 'Iron Fern', gains: { attack: '0' } },
  { playerId: 4, displayName: 'New recruit', gains: { attack: null } },
];
export const importPreview: ImportPreview = {
  competition,
  participants,
  previewToken: 'validated-token',
  expectedRevision: 'xp-one',
  expiresAt: '2099-10-05T12:05:00Z',
  changes: [
    {
      skill: 'attack',
      before: '18345678',
      after: '19595678',
      change: '1250000',
    },
  ],
  warnings: [],
};
export function publicXp(attack = '18345678', revision = 'xp-one') {
  return {
    '/api/v1/xp/skills': {
      revision,
      updatedAt: competition.importedAt,
      skills: Object.entries({ ...zeroTotals(), attack }).map(
        ([skill, xp]) => ({ skill, xp }),
      ),
    },
    '/api/v1/xp/competitions': { revision, competitions: [competition] },
    '/api/v1/xp/skills/attack/members': {
      revision,
      skill: 'attack',
      members: participants.map((p) => ({
        playerId: p.playerId,
        displayName: p.displayName,
        xp: p.gains.attack,
      })),
    },
    '/api/v1/xp/competitions/1001': { revision, competition, participants },
  } as Record<string, unknown>;
}
