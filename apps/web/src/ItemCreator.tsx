/** Decode a local icon, stage its upload, then create one item with multiple memberships. */
import { useCallback, useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  validateIconFile,
  validateIconSize,
  validateItem,
  type AdminCatalog,
  type AdminClient,
  type CreatedItem,
  type CreateItem,
  type StagedIcon,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { useAdminDraft } from './admin-route-data.ts';

/** Revoke preview URLs and close decoded bitmaps when replacing files or leaving the form. */
function IconPicker({
  disabled,
  onValid,
}: {
  disabled: boolean;
  onValid: (file: File | undefined) => void;
}) {
  const [file, setFile] = useState<File>(),
    [url, setUrl] = useState<string>(),
    [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false),
    [size, setSize] = useState<string>();
  useEffect(() => {
    let active = true,
      imageUrl: string | undefined;
    setUrl(undefined);
    setError(undefined);
    setSize(undefined);
    onValid(undefined);
    setChecking(Boolean(file));
    if (!file) return;
    void (async () => {
      await validateIconFile(file);
      const bitmap = await createImageBitmap(file);
      try {
        validateIconSize(bitmap.width, bitmap.height);
        if (!active) return;
        imageUrl = URL.createObjectURL(file);
        setUrl(imageUrl);
        setSize(bitmap.width + ' × ' + bitmap.height + ' pixels');
        onValid(file);
      } finally {
        bitmap.close();
      }
    })()
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error && !('code' in failure)
              ? failure.message
              : 'The file could not be decoded as a PNG/WebP icon.',
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [file, onValid]);
  return (
    <div className="icon-picker">
      <label>
        Item icon (required)
        <input
          type="file"
          accept="image/png,image/webp,.png,.webp"
          disabled={disabled}
          onChange={(event) => setFile(event.target.files?.[0])}
        />
      </label>
      <p className="admin-note">PNG or WebP</p>
      {checking && <p role="status">Checking icon…</p>}
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {url && (
        <div className="icon-picker__preview">
          <img src={url} alt="New item icon preview" />
          <span>{size}</span>
        </div>
      )}
    </div>
  );
}
export function ItemCreator({
  client,
  catalog,
  session,
  onAccessLost,
  refresh,
}: {
  client: AdminClient;
  catalog: AdminCatalog;
  session: AdminSession;
  onAccessLost: () => void;
  refresh: (signal: AbortSignal) => Promise<AdminCatalog>;
}) {
  const [name, setName] = useState(''),
    [pageIds, setPageIds] = useState<string[]>([]),
    [query, setQuery] = useState('');
  const [file, setFile] = useState<File>(),
    [staged, setStaged] = useState<StagedIcon>(),
    [reset, setReset] = useState(0);
  const [pending, setPending] = useState<{ fields: CreateItem; key: string }>(),
    [created, setCreated] = useState<CreatedItem>();
  useEffect(() => {
    if (pending) return;
    setPageIds((ids) => {
      const current = ids.filter((id) =>
        catalog.pages.some((page) => page.id === id),
      );
      return current.length === ids.length ? ids : current;
    });
  }, [catalog.pages, pending]);
  const action = useAdminAction(onAccessLost);
  useAdminDraft(!!(name || file || pageIds.length || pending), action.busy);
  const iconChanged = useCallback((file: File | undefined) => {
    setFile(file);
    setStaged(undefined);
  }, []);
  const locked = action.busy || Boolean(pending);
  const visiblePages = catalog.pages.filter(
    (page) =>
      page.name.toLowerCase().includes(query.toLowerCase().trim()) ||
      pageIds.includes(page.id),
  );
  const save = () => {
    void action.execute(async (signal) => {
      // Preserve payload and idempotency key after an uncertain response to avoid duplicates.
      let request = pending;
      if (!request) {
        if (!file) throw new Error('Choose a valid item icon before saving.');
        validateItem(
          { name, pageIds, iconAssetId: 'not-uploaded-yet' },
          catalog,
        );
        let icon = staged;
        if (!icon || Date.parse(icon.expiresAt) <= Date.now()) {
          icon = await client.upload(file, session.csrfToken, signal);
          if (signal.aborted) return;
          setStaged(icon);
        }
        request = {
          fields: validateItem(
            { name, pageIds, iconAssetId: icon.assetId },
            catalog,
          ),
          key: crypto.randomUUID(),
        };
        setPending(request);
      }
      let result: CreatedItem;
      try {
        result = await client.create(
          request.fields,
          request.key,
          session.csrfToken,
          signal,
        );
      } catch (failure) {
        if (
          failure instanceof AdminRequestError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          failure.status !== 408
        ) {
          setPending(undefined);
          if (failure.status === 422) setStaged(undefined);
        }
        throw failure;
      }
      if (signal.aborted) return;
      setCreated(result);
      setPending(undefined);
      setName('');
      setPageIds([]);
      setFile(undefined);
      setStaged(undefined);
      setReset((n) => n + 1);
      action.setMessage(
        'Item #' +
          result.item.id +
          ' created. Every selected page starts uncollected.',
      );
      try {
        await refresh(signal);
      } catch (failure) {
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          throw failure;
        action.setError(
          'The item was created, but the catalog could not be refreshed. Reload the page before adding another item.',
        );
      }
    });
  };
  return (
    <section
      className="admin-panel item-creator"
      aria-labelledby="add-item-title"
    >
      <h2 id="add-item-title">Add item</h2>
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
      {created && (
        <div className="admin-created">
          <img src={created.item.iconPath} alt="" />
          <div>
            <strong>
              {created.item.name} · #{created.item.id}
            </strong>
            <p>
              {created.pageIds
                .map(
                  (id) =>
                    catalog.pages.find((page) => page.id === id)?.name ?? id,
                )
                .join(', ')}
            </p>
            <span className="admin-badge">Manual item · uncollected</span>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset className="admin-fieldset" disabled={locked}>
          <IconPicker key={reset} disabled={locked} onValid={iconChanged} />
          <label>
            Item name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset className="page-picker">
            <legend>Collection-log pages (required)</legend>
            <input
              type="search"
              aria-label="Search collection-log pages"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="page-picker-choices">
              {visiblePages.map((page) => (
                <label className="admin-checkbox" key={page.id}>
                  <input
                    type="checkbox"
                    checked={pageIds.includes(page.id)}
                    onChange={(event) =>
                      setPageIds((ids) =>
                        event.target.checked
                          ? [...ids, page.id]
                          : ids.filter((id) => id !== page.id),
                      )
                    }
                  />
                  {page.name}
                </label>
              ))}
              {!visiblePages.length && (
                <p className="admin-empty">
                  {catalog.pages.length
                    ? 'No matching pages.'
                    : 'No collection-log pages yet. Create a page in Page management below.'}
                </p>
              )}
            </div>
          </fieldset>
          <p className="admin-note">{pageIds.length} pages selected.</p>
        </fieldset>
        {pending && !action.busy && (
          <p className="admin-note">
            The previous save has an uncertain result. Retry the same request
            before changing these details.
          </p>
        )}
        <button className="site-button" type="submit" disabled={action.busy}>
          {action.busy
            ? 'Saving item…'
            : pending
              ? 'Retry item save'
              : 'Create item'}
        </button>
      </form>
    </section>
  );
}
