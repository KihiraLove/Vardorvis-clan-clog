/** Public review contracts; game IDs never replace installation-local primary keys. */
export interface CatalogUpdateItem {
  key: string;
  name: string;
  gameItemIds: number[];
  image: { sha256: string; width: number; height: number };
  pageKeys: string[];
}
export interface CatalogUpdatePage {
  key: string;
  name: string;
  category: string;
}
export interface CatalogUpdateBatch {
  id: string;
  title: string;
  items: CatalogUpdateItem[];
  pages: CatalogUpdatePage[];
}
export interface CatalogUpdateProposal {
  id: string;
  kind:
    | 'name'
    | 'gameIds'
    | 'addGameId'
    | 'removeGameId'
    | 'image'
    | 'pageName'
    | 'pageCategory'
    | 'addLink'
    | 'removeLink'
    | 'adoptPage'
    | 'createPage'
    | 'createItem'
    | 'adopt';
  entityKey: string;
  localId: string;
  label: string;
  before: string;
  after: string;
  pageKey?: string;
  beforeLabel?: string;
  afterLabel?: string;
}
export interface CatalogUpdateConflict {
  entityKey: string;
  kind: 'item' | 'page';
  label: string;
  reason: string;
  candidates: { id: string; name: string }[];
}
export interface CatalogUpdateReview {
  revision: string;
  catalogRevision: string;
  autoOpen: boolean;
  releases: {
    id: string;
    title: string;
    addedItems: string[];
    addedPages: string[];
  }[];
  proposals: CatalogUpdateProposal[];
  conflicts: CatalogUpdateConflict[];
  pageMatches?: {
    entityKey: string;
    label: string;
    candidates: {
      id: string;
      name: string;
      category: string;
      active: boolean;
      matchedItems: string[];
      missingItems: string[];
      extraItems: string[];
    }[];
  }[];
  gameIdReviews?: {
    entityKey: string;
    localId: string;
    label: string;
    localIds: number[];
    suppliedIds: number[];
  }[];
  currentImages: {
    name: string;
    path: string;
    suppliedPath: string;
    identical: boolean;
  }[];
}
export interface CatalogUpdateSelection {
  revision: string;
  catalogRevision: string;
  apply: string[];
  keep: string[];
}
