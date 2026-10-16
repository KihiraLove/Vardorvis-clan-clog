/** Test-only public API responses; catalog fixtures never award collection credit. */
import rawCatalog from './catalog.json' with { type: 'json' };
import {
  parseCatalog,
  type Collections,
  type Credit,
} from '../../src/model.ts';

export const fixtureCatalog = parseCatalog(rawCatalog);
export type Scenario = 'uncollected' | 'collected' | 'hardcore';
export function fixtureCollections(scenario: Scenario): Collections {
  if (scenario === 'uncollected') return { revision: scenario, credits: [] };
  const itemId = fixtureCatalog.items.find(
    (item) => item.name === 'Virtus mask',
  )!.id;
  const credits: Credit[] = [
    {
      submissionId: 'test-ordinary',
      itemId,
      collectorName: 'KihiraVD',
      collectedOn: '2026-10-03',
      hardcore: false,
      status: 'approved',
    },
  ];
  if (scenario === 'hardcore')
    credits.push({
      submissionId: 'test-hardcore',
      itemId,
      collectorName: 'KihiraVD',
      collectedOn: '2026-10-05',
      hardcore: true,
      status: 'approved',
    });
  return { revision: scenario, credits };
}
