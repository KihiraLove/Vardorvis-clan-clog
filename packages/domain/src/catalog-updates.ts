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
    | 'image'
    | 'pageName'
    | 'pageCategory'
    | 'addLink'
    | 'removeLink'
    | 'adopt';
  entityKey: string;
  localId: string;
  label: string;
  before: string;
  after: string;
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
