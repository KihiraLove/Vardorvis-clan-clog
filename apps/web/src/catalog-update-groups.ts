import type { CatalogUpdateProposal, CatalogUpdateReview } from '@clog/domain';

export const catalogUpdateGroups = [
  ['pageNames', 'Page name mismatches'],
  ['pages', 'Missing pages'],
  ['items', 'Missing items'],
  ['names', 'Incorrect item names'],
  ['ids', 'Incorrect item ids'],
  ['links', 'Missing item-page relationships'],
  ['extraLinks', 'Incorrect item-page relationships'],
] as const;
export type CatalogUpdateGroup = (typeof catalogUpdateGroups)[number][0];
export function proposalGroup(
  p: CatalogUpdateProposal,
): CatalogUpdateGroup | 'icons' {
  switch (p.kind) {
    case 'pageName':
    case 'pageCategory':
      return 'pageNames';
    case 'adoptPage':
    case 'createPage':
      return 'pages';
    case 'createItem':
      return 'items';
    case 'name':
      return 'names';
    case 'gameIds':
    case 'addGameId':
    case 'removeGameId':
      return 'ids';
    case 'adopt':
      return p.before === 'Unlinked local page' ? 'pages' : 'ids';
    case 'addLink':
      return 'links';
    case 'removeLink':
      return 'extraLinks';
    case 'image':
      return 'icons';
  }
}
export function groupedCatalogReview(review: CatalogUpdateReview) {
  return catalogUpdateGroups
    .map(([key, title]) => ({
      key,
      title,
      proposals: review.proposals.filter((p) => proposalGroup(p) === key),
      conflicts: review.conflicts.filter(
        (c) => (c.kind === 'page' ? 'pages' : 'ids') === key,
      ),
    }))
    .filter((g) => g.proposals.length || g.conflicts.length);
}
export function selectedCatalogProposals(
  review: CatalogUpdateReview,
  groups: ReadonlySet<CatalogUpdateGroup>,
  icons: boolean,
  identities: Record<string, string>,
) {
  return review.proposals
    .filter((p) => {
      const group = proposalGroup(p);
      if (group === 'icons') return icons;
      if (!groups.has(group)) return false;
      if (
        ['adoptPage', 'createPage'].includes(p.kind) &&
        review.pageMatches?.some((m) => m.entityKey === p.entityKey)
      )
        return identities[p.entityKey] === p.id;
      return true;
    })
    .map((p) => p.id)
    .sort();
}
