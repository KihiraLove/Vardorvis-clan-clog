/** Admin-authored drops use the same review and world-credit ledger as bot claims. */
import { AdminRequestError } from './admin-api.ts';
import { useAdminAction } from './use-admin-action.ts';
import { useState } from 'react';
import {
  safeProof,
  type AdminCatalog,
  type AdminClient,
  type ManualSubmissionInput,
  type Submission,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminDraft } from './admin-route-data.ts';

export function ManualSubmissionForm({
  catalog,
  client,
  session,
  onAccessLost,
  onCreated,
}: {
  catalog: AdminCatalog;
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  onCreated: (result: Submission) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [itemId, setItemId] = useState('');
  const [collectorName, setCollectorName] = useState('');
  const [collectedOn, setCollectedOn] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [hardcore, setHardcore] = useState(false);
  const [proofUrl, setProofUrl] = useState('');
  const [screenshot, setScreenshot] = useState<File>();
  const [formVersion, setFormVersion] = useState(0);
  const [approve, setApprove] = useState(true);
  const [reason, setReason] = useState('');
  const action = useAdminAction(onAccessLost);
  const { busy, error, setError } = action;
  const [pending, setPending] = useState<{
    fields: ManualSubmissionInput;
    key: string;
    screenshot?: File | undefined;
  }>();
  useAdminDraft(
    !!(
      (open && itemId) ||
      collectorName ||
      proofUrl ||
      screenshot ||
      reason ||
      pending
    ),
    busy,
  );
  const options = catalog.items.filter(
    (item) =>
      item.name.toLowerCase().includes(search.toLowerCase().trim()) ||
      String(item.id) === search.trim(),
  );
  const chosen = catalog.items.find((item) => item.id === Number(itemId));
  const visible =
    chosen && !options.some((item) => item.id === chosen.id)
      ? [chosen, ...options]
      : options;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    if (!chosen || !collectorName.trim() || !collectedOn) {
      setError('Select a specific item, collector and collection date.');
      return;
    }
    if (proofUrl.trim() && !safeProof(proofUrl.trim())) {
      setError('Proof must be a supported HTTPS Imgur or Gyazo link.');
      return;
    }
    if (
      screenshot &&
      (screenshot.type !== 'image/png' || screenshot.size > 10 * 1024 * 1024)
    ) {
      setError('Choose a PNG screenshot up to 10 MiB.');
      return;
    }
    await action.execute(async (signal) => {
      const request = pending ?? {
        fields: {
          itemId: chosen.id,
          collectorName: collectorName.trim(),
          collectedOn,
          hardcore,
          proofUrl: proofUrl.trim(),
          approve,
          reason: reason.trim(),
        },
        key: crypto.randomUUID(),
        screenshot,
      };
      setPending(request);
      let result: Submission;
      try {
        result = await client.addManual(
          request.fields,
          request.key,
          session.csrfToken,
          signal,
          request.screenshot,
        );
      } catch (failure) {
        // Keep the exact request after a timeout, transport error or server failure.
        if (
          !signal.aborted &&
          failure instanceof AdminRequestError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          ![408, 429].includes(failure.status)
        ) {
          setPending(undefined);
          if (failure.status === 409 && request.fields.approve)
            throw new Error(
              chosen.name +
                ' is already collected in ' +
                (hardcore ? 'hardcore' : 'ordinary') +
                ' worlds. Revoke or edit the existing approved entry instead.',
              { cause: failure },
            );
        }
        throw failure;
      }
      if (signal.aborted) return;
      setPending(undefined);
      setSearch('');
      setItemId('');
      setCollectorName('');
      setCollectedOn('');
      setHardcore(false);
      setProofUrl('');
      setScreenshot(undefined);
      setFormVersion((value) => value + 1);
      setApprove(true);
      setReason('');
      action.setMessage('Manual submission created successfully.');
      onCreated(result);
    });
  };

  return (
    <section className="admin-panel">
      <div className="admin-section-heading">
        <div>
          <h2>Manual submission</h2>
        </div>
        <button
          className="site-button"
          type="button"
          disabled={busy}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Cancel manual entry' : 'Add manual submission'}
        </button>
      </div>
      {action.message && (
        <p role="status" className="admin-success">
          {action.message}
        </p>
      )}
      {open && (
        <form key={formVersion} onSubmit={(event) => void submit(event)}>
          <fieldset
            className="admin-fieldset"
            disabled={busy || Boolean(pending)}
          >
            <div className="admin-form-grid">
              <label>
                Search catalog items
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label>
                Canonical item
                <select
                  aria-label="Canonical item"
                  className="catalog-choice-list"
                  required
                  size={5}
                  value={itemId}
                  onChange={(event) => setItemId(event.target.value)}
                >
                  <option value="">Choose the exact item…</option>
                  {visible.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · #{item.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Collector name
                <input
                  required
                  maxLength={80}
                  value={collectorName}
                  onChange={(event) => setCollectorName(event.target.value)}
                />
              </label>
              <label>
                Collection date
                <input
                  type="date"
                  required
                  max={new Date().toISOString().slice(0, 10)}
                  value={collectedOn}
                  onChange={(event) => setCollectedOn(event.target.value)}
                />
              </label>
              <label>
                PNG screenshot (optional)
                <input
                  type="file"
                  accept="image/png,.png"
                  onChange={(event) => setScreenshot(event.target.files?.[0])}
                />
                <span className="admin-note">Up to 10 MiB.</span>
              </label>
              <label>
                Proof URL (optional)
                <input
                  type="url"
                  value={proofUrl}
                  placeholder="https://imgur.com/…"
                  onChange={(event) => setProofUrl(event.target.value)}
                />
              </label>
              <label>
                Reason or note (optional)
                <textarea
                  maxLength={1000}
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </div>
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={hardcore}
                onChange={(event) => setHardcore(event.target.checked)}
              />
              Collected on hardcore worlds
            </label>
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={approve}
                onChange={(event) => setApprove(event.target.checked)}
              />
              Approve immediately and show in the collection log
            </label>
          </fieldset>
          {pending && (
            <p className="admin-note">
              Retry to confirm this submission before changing its details.
            </p>
          )}
          {error && (
            <p role="alert" className="admin-error">
              {error}
            </p>
          )}
          <button className="site-button" type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : pending
                ? 'Retry manual submission'
                : 'Create manual submission'}
          </button>
        </form>
      )}
    </section>
  );
}
