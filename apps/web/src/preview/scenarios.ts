import rawCatalog from './catalog.json';
import { parseCatalog, type Collections, type Credit } from '../model.ts';

export const previewCatalog = parseCatalog(rawCatalog);
export const scenarios = [
  { id: 'uncollected', name: 'All uncollected' },
  { id: 'collected', name: 'Ordinary collection' },
  { id: 'hardcore', name: 'Mixed hardcore credits' },
] as const;
export type Scenario = (typeof scenarios)[number]['id'];
export function previewCollections(scenario: Scenario): Collections {
  if (scenario === 'uncollected') return { revision: scenario, credits: [] };
  const itemId = previewCatalog.items.find(
    (item) => item.name === 'Virtus mask',
  )!.id;
  const credits: Credit[] = [
    {
      submissionId: 'preview-ordinary',
      itemId,
      collectorName: 'KihiraVD',
      collectedOn: '2026-10-03',
      hardcore: false,
      status: 'approved',
    },
  ];
  if (scenario === 'hardcore')
    credits.push({
      submissionId: 'preview-hardcore',
      itemId,
      collectorName: 'KihiraVD',
      collectedOn: '2026-10-05',
      hardcore: true,
      status: 'approved',
    });
  return { revision: scenario, credits };
}
