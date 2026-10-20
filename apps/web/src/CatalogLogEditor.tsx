/** The shared catalog presented as an editable collection log. Reordering stays local until explicitly saved. */
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { catalogSections } from './model.ts';
import type { AdminCatalog, AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { useAdminDraft } from './admin-route-data.ts';
import { CatalogInspector, type CatalogEditor } from './CatalogInspector.tsx';

export interface CatalogEditorProps {
  catalog: AdminCatalog;
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  refresh: (signal: AbortSignal) => Promise<AdminCatalog>;
}
type DragKind = 'section' | 'page' | 'item';
interface DragIdentity {
  kind: DragKind;
  scope: string;
  id: string;
}
export function CatalogLogEditor(props: CatalogEditorProps) {
  const { catalog, client, session, refresh, onAccessLost } = props;
  const [draftOrder, setDraftOrder] = useState<{
    sections?: string[];
    pages: Record<string, string[]>;
    items: Record<string, string[]>;
  }>({ pages: {}, items: {} });
  const arrange = <T,>(
    entries: readonly T[],
    ids: string[] | undefined,
    key: (entry: T) => string,
  ): T[] => {
    if (!ids) return [...entries];
    const rank = new Map(ids.map((id, index) => [id, index]));
    return [...entries].sort(
      (a, b) =>
        (rank.get(key(a)) ?? ids.length) - (rank.get(key(b)) ?? ids.length),
    );
  };
  const sections = arrange(
    catalogSections(catalog),
    draftOrder.sections,
    (s) => s.id,
  );
  const displayPages = sections.flatMap((s) =>
    arrange(
      catalog.pages.filter((p) => p.category === s.id),
      draftOrder.pages[s.id],
      (p) => p.id,
    ).map((p) => ({
      ...p,
      itemIds: arrange(p.itemIds, draftOrder.items[p.id], String),
    })),
  );
  const orderDirty =
    sections.some((s, index) => s.id !== catalogSections(catalog)[index]?.id) ||
    sections.some((s) =>
      displayPages
        .filter((p) => p.category === s.id)
        .some(
          (p, index) =>
            p.id !==
            catalog.pages.filter((p) => p.category === s.id)[index]?.id,
        ),
    ) ||
    displayPages.some((p) =>
      p.itemIds.some(
        (id, index) =>
          id !==
          catalog.pages.find((original) => original.id === p.id)?.itemIds[
            index
          ],
      ),
    );
  const initial =
    catalog.pages.find((p) => p.id === 'vardorvis') ?? catalog.pages[0];
  const [sectionId, setSectionId] = useState(
      initial?.category ?? sections[0]?.id ?? '',
    ),
    [pageId, setPageId] = useState(initial?.id ?? '');
  const [editor, setEditor] = useState<CatalogEditor>(),
    [formState, setFormState] = useState({ dirty: false, busy: false });
  const action = useAdminAction(onAccessLost),
    locked = action.busy || formState.busy;
  useAdminDraft(orderDirty, locked);
  const panelRef = useRef<HTMLElement>(null);
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const pages = displayPages.filter((p) => p.category === section?.id);
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const items = new Map(catalog.items.map((item) => [item.id, item]));
  useEffect(() => {
    if (editor)
      panelRef.current?.querySelector<HTMLElement>('input,button')?.focus();
  }, [editor]);
  const open = (next: CatalogEditor | undefined) => {
    if (locked) return false;
    if (formState.dirty && !window.confirm('Discard the unsaved catalog edit?'))
      return false;
    setFormState({ dirty: false, busy: false });
    setEditor(next);
    return true;
  };
  const stageOrder = (kind: DragKind, ids: string[]) => {
    if (locked) return;
    action.setMessage(undefined);
    setDraftOrder((current) =>
      kind === 'section'
        ? { ...current, sections: ids }
        : kind === 'page' && section
          ? { ...current, pages: { ...current.pages, [section.id]: ids } }
          : kind === 'item' && page
            ? { ...current, items: { ...current.items, [page.id]: ids } }
            : current,
    );
  };
  const saveOrder = () => {
    if (locked || !orderDirty) return;
    void action.execute(
      async (signal) => {
        let current = catalog;
        const desiredSections = sections.map((s) => s.id);
        const same = (
          a: readonly (string | number)[],
          b: readonly (string | number)[],
        ) => JSON.stringify(a) === JSON.stringify(b);
        if (
          !same(
            desiredSections,
            catalogSections(current).map((s) => s.id),
          )
        ) {
          await client.reorderSections(
            desiredSections,
            current.revision,
            session.csrfToken,
            signal,
          );
          current = await refresh(signal);
          signal.throwIfAborted();
        }
        for (const section of sections) {
          const desiredPages = displayPages
            .filter((p) => p.category === section.id)
            .map((p) => p.id);
          if (
            !same(
              desiredPages,
              current.pages
                .filter((p) => p.category === section.id)
                .map((p) => p.id),
            )
          ) {
            await client.reorderPages(
              section.id,
              desiredPages,
              current.revision,
              session.csrfToken,
              signal,
            );
            current = await refresh(signal);
            signal.throwIfAborted();
          }
        }
        for (const page of displayPages) {
          const saved = current.pages.find((p) => p.id === page.id);
          if (saved && !same(page.itemIds, saved.itemIds)) {
            await client.order(
              page.id,
              page.itemIds,
              saved.version,
              session.csrfToken,
              signal,
            );
            current = await refresh(signal);
            signal.throwIfAborted();
          }
        }
        if (!signal.aborted) {
          setDraftOrder({ pages: {}, items: {} });
          action.setMessage('Item order saved.');
        }
      },
      async (signal) => {
        await refresh(signal);
      },
    );
  };
  const ordered = (kind: DragKind) =>
    kind === 'section'
      ? sections.map((s) => s.id)
      : kind === 'page'
        ? pages.map((p) => p.id)
        : (page?.itemIds ?? []).map(String);
  const move = (kind: DragKind, from: string, to: string) => {
    const ids = ordered(kind),
      start = ids.indexOf(from),
      end = ids.indexOf(to);
    if (start < 0 || end < 0 || start === end) return;
    ids.splice(start, 1);
    ids.splice(end, 0, from);
    stageOrder(kind, ids);
  };
  const scope = (kind: DragKind) =>
    kind === 'section'
      ? 'catalog'
      : kind === 'page'
        ? (section?.id ?? '')
        : (page?.id ?? '');
  const drop = (event: DragEvent, kind: DragKind, id: string) => {
    event.preventDefault();
    if (locked) return;
    try {
      const drag = JSON.parse(
        event.dataTransfer.getData('application/x-clog-catalog'),
      ) as DragIdentity;
      if (drag.kind === kind && drag.scope === scope(kind))
        move(kind, drag.id, id);
    } catch {
      /* External drags are not catalog changes. */
    }
  };
  const grip = (kind: DragKind, id: string, name: string) => (
    <button
      type="button"
      className="catalog-grip order-grip"
      aria-label={`Reorder ${kind} ${name}`}
      title="Drag to reorder; Alt + arrow keys also move"
      disabled={locked}
      draggable={!locked}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          'application/x-clog-catalog',
          JSON.stringify({ kind, scope: scope(kind), id }),
        );
        event.dataTransfer.effectAllowed = 'move';
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (
          !event.altKey ||
          !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        const ids = ordered(kind),
          index = ids.indexOf(id),
          next =
            index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1);
        if (ids[next]) move(kind, id, ids[next]!);
      }}
    >
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
  const gear = (label: string, next: CatalogEditor) => (
    <button
      type="button"
      className="catalog-gear"
      aria-label={label}
      title={label}
      disabled={locked}
      onClick={() => open(next)}
    >
      <span aria-hidden="true">⚙</span>
    </button>
  );
  const target = (kind: DragKind, id: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!locked) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    },
    onDrop: (event: DragEvent) => drop(event, kind, id),
  });
  return (
    <div
      className={`catalog-workspace${editor ? ' catalog-workspace--editing' : ''}`}
    >
      <section
        className="catalog-log-wrap"
        aria-label="Items catalog collection log"
      >
        <div className="game-window catalog-log">
          <header className="catalog-titlebar">
            <h2>Items catalog</h2>
          </header>
          <div
            className="game-tabs catalog-tabs"
            role="tablist"
            aria-label="Catalog sections"
          >
            {sections.map((entry, index) => (
              <div
                className="catalog-tab"
                key={entry.id}
                {...target('section', entry.id)}
              >
                {grip('section', entry.id, entry.name)}
                <button
                  type="button"
                  role="tab"
                  id={`catalog-tab-${entry.id}`}
                  aria-selected={section?.id === entry.id}
                  aria-controls="catalog-panel"
                  tabIndex={section?.id === entry.id ? 0 : -1}
                  disabled={locked}
                  onClick={() => {
                    if (open(undefined)) {
                      setSectionId(entry.id);
                      setPageId('');
                    }
                  }}
                  onKeyDown={(event) => {
                    let next: number;
                    if (event.key === 'ArrowRight')
                      next = (index + 1) % sections.length;
                    else if (event.key === 'ArrowLeft')
                      next = (index + sections.length - 1) % sections.length;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = sections.length - 1;
                    else return;
                    event.preventDefault();
                    const selected = sections[next]!;
                    setSectionId(selected.id);
                    setPageId('');
                    document
                      .getElementById(`catalog-tab-${selected.id}`)
                      ?.focus();
                  }}
                >
                  {entry.name}
                </button>
                {gear(`Edit section ${entry.name}`, {
                  kind: 'section-edit',
                  id: entry.id,
                })}
              </div>
            ))}
            <button
              type="button"
              className="catalog-add"
              disabled={locked}
              onClick={() => open({ kind: 'section-add' })}
            >
              <span className="catalog-add-plus">+</span> Add section
            </button>
          </div>
          <div
            className="game-body"
            role="tabpanel"
            id="catalog-panel"
            aria-labelledby={section ? `catalog-tab-${section.id}` : undefined}
          >
            <aside
              className="game-sidebar"
              aria-label={`${section?.name ?? 'Catalog'} pages`}
            >
              <div className="page-list game-scroll catalog-page-list">
                {pages.map((entry) => {
                  return (
                    <div
                      className="catalog-page-row"
                      key={entry.id}
                      data-page-id={entry.id}
                      {...target('page', entry.id)}
                    >
                      {grip('page', entry.id, entry.name)}
                      <button
                        type="button"
                        className="catalog-page-name"
                        aria-current={
                          page?.id === entry.id ? 'page' : undefined
                        }
                        disabled={locked}
                        onClick={() => {
                          if (open(undefined)) setPageId(entry.id);
                        }}
                      >
                        {entry.name}
                      </button>
                      {gear(`Edit page ${entry.name}`, {
                        kind: 'page-edit',
                        id: entry.id,
                      })}
                    </div>
                  );
                })}
                {section && (
                  <button
                    type="button"
                    className="catalog-add"
                    disabled={locked}
                    onClick={() => open({ kind: 'page-add', id: section.id })}
                  >
                    <span className="catalog-add-plus">+</span> Add page
                  </button>
                )}
              </div>
            </aside>
            <div className="game-content">
              {page ? (
                <>
                  <div className="page-heading">
                    <h3>{page.name}</h3>
                  </div>
                  <div className="item-area game-scroll">
                    <div
                      className="item-grid"
                      aria-label={`${page.name} items`}
                    >
                      {page.itemIds.map((id) => {
                        const item = items.get(id)!;
                        return (
                          <div
                            className="catalog-item"
                            key={id}
                            data-item-id={id}
                            {...target('item', String(id))}
                          >
                            {grip('item', String(id), item.name)}
                            <button
                              type="button"
                              className="item-slot"
                              aria-label={`Edit item ${item.name}`}
                              disabled={locked}
                              onClick={() => open({ kind: 'item-edit', id })}
                            >
                              <img
                                src={item.iconPath}
                                alt=""
                                draggable={false}
                              />
                            </button>
                            {gear(`Item settings for ${item.name}`, {
                              kind: 'item-edit',
                              id,
                            })}
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="catalog-add catalog-add-item"
                        disabled={locked}
                        onClick={() => open({ kind: 'item-add', id: page.id })}
                      >
                        <span className="catalog-add-plus">+</span> Add item
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="log-state">
                  <p>
                    {section
                      ? 'Add a page to this section.'
                      : 'Add a section to start.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
        {(orderDirty || action.message) && (
          <div className="catalog-order-save">
            <button
              type="button"
              className="site-button"
              disabled={locked || !orderDirty}
              onClick={saveOrder}
            >
              {action.busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
        {action.error && (
          <p role="alert" className="admin-error">
            {action.error}
          </p>
        )}
        {action.message && (
          <p role="status" className="admin-success">
            {action.message}
          </p>
        )}
      </section>
      {editor && (
        <aside
          ref={panelRef}
          className="catalog-inspector admin-panel"
          aria-label="Catalog editor"
        >
          <button
            type="button"
            className="site-button catalog-close"
            aria-label="Close editor"
            disabled={locked}
            onClick={() => open(undefined)}
          >
            ×
          </button>
          <CatalogInspector
            key={`${editor.kind}-${'id' in editor ? editor.id : ''}`}
            {...props}
            editor={editor}
            order={(() => {
              const kind: DragKind | undefined =
                editor.kind === 'section-edit'
                  ? 'section'
                  : editor.kind === 'page-edit'
                    ? 'page'
                    : editor.kind === 'item-edit'
                      ? 'item'
                      : undefined;
              if (!kind || !('id' in editor)) return undefined;
              const ids = ordered(kind),
                id = String(editor.id),
                index = ids.indexOf(id);
              return {
                previous: !locked && index > 0,
                next: !locked && index >= 0 && index < ids.length - 1,
                move: (offset: number) => {
                  if (ids[index + offset]) move(kind, id, ids[index + offset]!);
                },
              };
            })()}
            onStateChange={setFormState}
            onOpen={open}
            onDone={() => {
              setFormState({ dirty: false, busy: false });
              setEditor(undefined);
            }}
            onCreatedPage={(created) => {
              setSectionId(created.category);
              setPageId(created.id);
            }}
            onCreatedSection={(id) => {
              setSectionId(id);
              setPageId('');
            }}
          />
        </aside>
      )}
    </div>
  );
}
