/** Wire-shaped fixtures distinguish positive, zero and unavailable participant gains. */
import { type SkillId } from '../src/xp-model.ts';
import { type ImportPreview } from './support/xp-contracts.ts';

export const competition = {
  id: 1001,
  title: 'Clan Attack week',
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
