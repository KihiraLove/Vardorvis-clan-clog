/** The shared catalog presented as an editable collection log. Writes publish immediately. */
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { catalogSections, progressClass } from './model.ts';
import type { AdminCatalog, AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
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
  const sections = catalogSections(catalog);
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
  const panelRef = useRef<HTMLElement>(null);
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const pages = catalog.pages.filter((p) => p.category === section?.id);
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const collected = new Set(catalog.collectedItemIds ?? []);
  const count = (ids: number[]) => ({
    collected: ids.filter((id) => collected.has(id)).length,
    total: ids.length,
  });
  const pageCount = count(page?.itemIds ?? []),
    items = new Map(catalog.items.map((item) => [item.id, item]));
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
  const saveOrder = (kind: DragKind, ids: string[]) => {
    if (locked) return;
    void action.execute(
      async (signal) => {
        if (kind === 'section')
          await client.reorderSections(
            ids,
            catalog.revision,
            session.csrfToken,
            signal,
          );
        else if (kind === 'page' && section)
          await client.reorderPages(
            section.id,
            ids,
            catalog.revision,
            session.csrfToken,
            signal,
          );
        else if (kind === 'item' && page)
          await client.order(
            page.id,
            ids.map(Number),
            page.version,
            session.csrfToken,
            signal,
          );
        await refresh(signal);
        if (!signal.aborted)
          action.setMessage(
            `${kind === 'section' ? 'Section' : kind === 'page' ? 'Page' : 'Item'} order saved.`,
          );
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
    saveOrder(kind, ids);
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
              + Add section
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
                  const c = count(entry.itemIds);
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
                        className={`catalog-page-name ${c.total > 0 && c.collected === c.total ? 'complete' : ''}`}
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
                    + Add page
                  </button>
                )}
              </div>
            </aside>
            <div className="game-content">
              {page ? (
                <>
                  <div className="page-heading">
                    <h3>{page.name}</h3>
                    <p>
                      Obtained:{' '}
                      <span
                        className={progressClass(
                          pageCount.collected,
                          pageCount.total,
                        )}
                      >
                        {pageCount.collected}/{pageCount.total}
                      </span>
                    </p>
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
                              className={`item-slot${collected.has(id) ? ' item-slot--collected' : ''}`}
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
                        + Add item
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
        {action.busy && <p role="status">Saving order…</p>}
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
            disabled={locked}
            onClick={() => open(undefined)}
          >
            Close editor
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
