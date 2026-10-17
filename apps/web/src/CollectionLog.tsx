/** Render the five-tab log, per-category selection, canonical progress and item history. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from 'react';
import {
  catalogSections,
  progressClass,
  itemState,
  progress,
  modeCredits,
  type Category,
  type Credit,
  type LogData,
  type Item,
} from './model.ts';
import { ItemMenu, type OpenItem } from './ItemMenu.tsx';
import { defaultSiteCopy, type SiteCopy } from '@clog/domain';

/** Hover/focus opens transient history; clicking or tapping pins it until dismissal. */
function ItemSlot({
  item,
  credits,
  open,
  show,
  leave,
  close,
}: {
  item: Item;
  credits: Credit[];
  open: OpenItem | undefined;
  show: (next: OpenItem) => void;
  leave: () => void;
  close: () => void;
}) {
  const state = itemState(item.id, credits);
  const [broken, setBroken] = useState(false);
  const active = open?.item.id === item.id;
  const reveal = (anchor: HTMLElement, pinned: boolean) =>
    state.collected &&
    show({
      item,
      anchor,
      collectors: state.collectors,
      hardcore: state.hardcoreCollected,
      pinned,
    });
  return (
    <button
      type="button"
      className={`item-slot${state.collected ? ' item-slot--collected' : ''}${state.hardcoreCollected ? ' item-slot--hardcore' : ''}`}
      aria-label={`${item.name}: ${state.collected ? 'collected' : 'not collected'}${state.hardcoreCollected ? ', hardcore' : ''}`}
      aria-describedby={active ? `item-menu-${item.id}` : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') reveal(event.currentTarget, false);
      }}
      onPointerLeave={leave}
      onFocus={(event) => reveal(event.currentTarget, false)}
      onBlur={() => {
        if (!open?.pinned) leave();
      }}
      onClick={(event) => {
        if (active && open?.pinned) close();
        else reveal(event.currentTarget, true);
      }}
    >
      {broken ? (
        <span className="icon-missing" aria-label="Icon unavailable">
          ?
        </span>
      ) : (
        <img
          src={item.iconPath}
          alt=""
          draggable="false"
          onError={() => setBroken(true)}
        />
      )}
    </button>
  );
}

export function CollectionLog({
  data,
  loading = false,
  error,
  retry,
  hardcore = false,
  copy = defaultSiteCopy,
  activity,
}: {
  data?: LogData | undefined;
  loading?: boolean;
  error?: string | undefined;
  retry?: (() => void) | undefined;
  hardcore?: boolean;
  copy?: SiteCopy;
  activity: ReactNode;
}) {
  const requestedPage = new URLSearchParams(window.location.search).get('page');
  const firstPage =
    data?.catalog.pages.find((page) => page.id === requestedPage) ??
    data?.catalog.pages.find((page) => page.id === 'vardorvis');
  const [category, setCategory] = useState<Category>(
    firstPage?.category ?? 'bosses',
  );
  const [selection, setSelection] = useState<Partial<Record<Category, string>>>(
    firstPage ? { [firstPage.category]: firstPage.id } : {},
  );
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const scale = 2;
  const [open, setOpen] = useState<OpenItem>();
  const searchRef = useRef<HTMLInputElement>(null);
  const pageListRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const catalog = data?.catalog;
  const categories = catalogSections(catalog);
  useEffect(() => {
    if (catalog && !categories.some((section) => section.id === category))
      setCategory(categories[0]?.id ?? '');
  }, [catalog, categories, category]);
  // Resolve deep links once asynchronous live data arrives without resetting later choices.
  const initialized = useRef(Boolean(catalog));
  useEffect(() => {
    if (!catalog || initialized.current) return;
    initialized.current = true;
    const initial =
      catalog.pages.find((entry) => entry.id === requestedPage) ??
      catalog.pages.find((entry) => entry.id === 'vardorvis') ??
      catalog.pages[0];
    if (initial) {
      setCategory(initial.category);
      setSelection({ [initial.category]: initial.id });
    }
  }, [catalog, requestedPage]);
  const credits = modeCredits(data?.collections.credits ?? [], hardcore);
  const pages =
    catalog?.pages.filter((page) => page.category === category) ?? [];
  const page =
    pages.find((entry) => entry.id === selection[category]) ?? pages[0];
  const visiblePages = pages.filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const items = new Map(catalog?.items.map((item) => [item.id, item]));
  const globalProgress = progress(
    catalog?.pages.flatMap((page) => page.itemIds) ?? [],
    credits,
  );
  const pageProgress = progress(page?.itemIds ?? [], credits);
  const stay = useCallback(() => window.clearTimeout(hideTimer.current), []);
  const close = useCallback(() => {
    stay();
    setOpen(undefined);
  }, [stay]);
  const show = (next: OpenItem) => {
    stay();
    setOpen(next);
  };
  // A short grace period lets the pointer cross from an item into its portal tooltip.
  const leave = () => {
    stay();
    if (!open?.pinned)
      hideTimer.current = window.setTimeout(() => setOpen(undefined), 160);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    close();
  }, [hardcore, close]);
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  const chooseCategory = (next: Category) => {
    close();
    setCategory(next);
    setQuery('');
    pageListRef.current?.scrollTo(0, 0);
    gridRef.current?.scrollTo(0, 0);
  };
  // Roving tab focus implements arrow/Home/End navigation without extra tab stops.
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % categories.length;
    else if (event.key === 'ArrowLeft')
      next = (index + categories.length - 1) % categories.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = categories.length - 1;
    else return;
    event.preventDefault();
    const tab = categories[next]!;
    chooseCategory(tab.id);
    document.getElementById(`tab-${tab.id}`)?.focus();
  };

  return (
    <section
      className="collection-section public-log-layout"
      aria-label="Clan collection log"
      style={{ '--log-scale': scale } as CSSProperties}
    >
      <h1 className="log-help">
        {copy.collectionCaption}
        {hardcore && ' Hardcore worlds'}
      </h1>
      {activity}
      <div className="log-viewport">
        <div className="log-sizing">
          <div className="game-window">
            <header className="game-titlebar">
              <h2>
                Collection Log
                {catalog && (
                  <>
                    {' '}
                    -{' '}
                    <span
                      className={
                        globalProgress.collected === globalProgress.total &&
                        globalProgress.total > 0
                          ? 'complete'
                          : ''
                      }
                    >
                      {globalProgress.collected}/{globalProgress.total}
                    </span>
                  </>
                )}
              </h2>
              <button
                className="game-search"
                type="button"
                aria-expanded={searching}
                aria-controls="page-search"
                onClick={() => {
                  close();
                  setSearching(!searching);
                  setQuery('');
                }}
              >
                <span aria-hidden="true">⌕</span> Search
              </button>
            </header>
            <div
              className="game-tabs"
              role="tablist"
              aria-label="Collection log categories"
            >
              {categories.map((tab, index) => (
                <button
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  key={tab.id}
                  aria-selected={category === tab.id}
                  aria-controls="log-panel"
                  tabIndex={category === tab.id ? 0 : -1}
                  onClick={() => chooseCategory(tab.id)}
                  onKeyDown={(event) => tabKey(event, index)}
                >
                  {tab.name}
                </button>
              ))}
            </div>
            <div
              className="game-body"
              role="tabpanel"
              id="log-panel"
              aria-labelledby={`tab-${category}`}
            >
              <aside
                className="game-sidebar"
                aria-label={`${categories.find((tab) => tab.id === category)?.name ?? 'Collection log'} pages`}
              >
                {searching && (
                  <label className="page-search" id="page-search">
                    <span className="sr-only">Search pages</span>
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search pages..."
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setSearching(false);
                          setQuery('');
                        }
                      }}
                    />
                  </label>
                )}
                <div className="page-list game-scroll" ref={pageListRef}>
                  {visiblePages.map((entry) => {
                    const count = progress(entry.itemIds, credits);
                    return (
                      <button
                        type="button"
                        key={entry.id}
                        aria-current={
                          page?.id === entry.id ? 'page' : undefined
                        }
                        className={
                          count.total > 0 && count.collected === count.total
                            ? 'complete'
                            : count.collected === 0
                              ? 'uncollected'
                              : ''
                        }
                        onClick={() => {
                          close();
                          setSelection((current) => ({
                            ...current,
                            [category]: entry.id,
                          }));
                          gridRef.current?.scrollTo(0, 0);
                        }}
                      >
                        {entry.name}
                      </button>
                    );
                  })}
                  {catalog && !visiblePages.length && (
                    <p className="list-empty">
                      {query
                        ? 'No matching pages.'
                        : 'No pages in this category.'}
                    </p>
                  )}
                </div>
              </aside>
              <div className="game-content">
                {catalog && page ? (
                  <>
                    <div className="page-heading">
                      <h3>{page.name}</h3>
                      <p>
                        Obtained:{' '}
                        <span
                          className={progressClass(
                            pageProgress.collected,
                            pageProgress.total,
                          )}
                        >
                          {pageProgress.collected}/{pageProgress.total}
                        </span>
                      </p>
                    </div>
                    <div className="item-area game-scroll" ref={gridRef}>
                      <div
                        className="item-grid"
                        aria-label={`${page.name} items`}
                      >
                        {page.itemIds.map((itemId) => (
                          <ItemSlot
                            key={itemId}
                            item={items.get(itemId)!}
                            credits={credits}
                            open={open}
                            show={show}
                            leave={leave}
                            close={close}
                          />
                        ))}
                      </div>
                      {!page.itemIds.length && (
                        <p className="list-empty">No items on this page yet.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="log-state" role={error ? 'alert' : 'status'}>
                    <h3>
                      {loading
                        ? 'Loading collection log...'
                        : error
                          ? 'Collection log unavailable'
                          : 'No catalog yet'}
                    </h3>
                    <p>
                      {loading
                        ? 'Fetching pages and collected items.'
                        : (error ??
                          'No collection-log pages have been published.')}
                    </p>
                    {retry && !loading && (
                      <button
                        className="game-button"
                        type="button"
                        onClick={retry}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {data && error && (
        <p className="refresh-error" role="status">
          {error} Showing the last successful update.{' '}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </p>
      )}
      {open &&
        itemState(open.item.id, credits).collected &&
        (() => {
          const current = itemState(open.item.id, credits);
          return (
            <ItemMenu
              open={{
                ...open,
                collectors: current.collectors,
                hardcore: current.hardcoreCollected,
              }}
              close={close}
              stay={stay}
              leave={leave}
            />
          );
        })()}
    </section>
  );
}
