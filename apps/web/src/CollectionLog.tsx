import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  categories,
  itemState,
  progress,
  type Category,
  type Credit,
  type LogData,
  type Item,
} from './model.ts';
import { ItemMenu, type OpenItem } from './ItemMenu.tsx';

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
  preview = false,
  onPreview,
}: {
  data?: LogData | undefined;
  loading?: boolean;
  error?: string | undefined;
  retry?: (() => void) | undefined;
  preview?: boolean;
  onPreview?: (() => void) | undefined;
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
  const [closed, setClosed] = useState(false);
  const [scale, setScale] = useState(window.innerWidth >= 800 ? 1.5 : 1);
  const [open, setOpen] = useState<OpenItem>();
  const searchRef = useRef<HTMLInputElement>(null);
  const pageListRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const catalog = data?.catalog;
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
  const credits = data?.collections.credits ?? [];
  const pages =
    catalog?.pages.filter((page) => page.category === category) ?? [];
  const page =
    pages.find((entry) => entry.id === selection[category]) ?? pages[0];
  const visiblePages = pages.filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const items = new Map(catalog?.items.map((item) => [item.id, item]));
  const globalProgress = progress(
    catalog?.items.map((item) => item.id) ?? [],
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
  const leave = () => {
    stay();
    if (!open?.pinned)
      hideTimer.current = window.setTimeout(() => setOpen(undefined), 160);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
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
    <section className="collection-section" aria-label="Clan collection log">
      <div className="view-controls">
        <span>{preview ? 'Preview catalog' : 'Clan collection log'}</span>
        <div role="group" aria-label="Log display size">
          <button
            type="button"
            aria-pressed={scale === 1}
            onClick={() => {
              close();
              setScale(1);
            }}
          >
            Native 1×
          </button>
          <button
            type="button"
            aria-pressed={scale === 1.5}
            onClick={() => {
              close();
              setScale(1.5);
            }}
          >
            Larger 1.5×
          </button>
        </div>
      </div>
      {closed ? (
        <div className="reopen">
          <button className="site-button" onClick={() => setClosed(false)}>
            Open collection log
          </button>
        </div>
      ) : (
        <div className="log-viewport">
          <div
            className="log-sizing"
            style={{ width: 500 * scale, height: 314 * scale }}
          >
            <div
              className="game-window"
              style={{ transform: `scale(${scale})` }}
            >
              <header className="game-titlebar">
                <span className="log-book" aria-hidden="true">
                  ▤
                </span>
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
                  className="game-close"
                  type="button"
                  aria-label="Close collection log"
                  onClick={() => {
                    close();
                    setClosed(true);
                  }}
                >
                  ×
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
                  aria-label={`${categories.find((tab) => tab.id === category)!.name} pages`}
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
                            className={
                              pageProgress.collected === pageProgress.total &&
                              pageProgress.total > 0
                                ? 'complete'
                                : 'count'
                            }
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
                          <p className="list-empty">
                            No items on this page yet.
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <div
                      className="log-state"
                      role={error ? 'alert' : 'status'}
                    >
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
                      {onPreview && !loading && (
                        <button
                          className="game-button"
                          type="button"
                          onClick={onPreview}
                        >
                          View frontend preview
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {data && error && (
        <p className="refresh-error" role="status">
          {error} Showing the last successful update.{' '}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </p>
      )}
      <p className="log-help">
        Hover, focus or tap an item to view its collection history.
      </p>
      {open &&
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
