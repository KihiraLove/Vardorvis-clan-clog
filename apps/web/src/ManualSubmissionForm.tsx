/** Admin-authored drops use the same review and world-credit ledger as bot claims. */
import { useState } from 'react';
import { safeProof, type AdminCatalog, type AdminClient, type Submission } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';

export function ManualSubmissionForm({
  catalog, client, session, onAccessLost, onCreated,
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
  const [collectedOn, setCollectedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [hardcore, setHardcore] = useState(false);
  const [proofUrl, setProofUrl] = useState('');
  const [approve, setApprove] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const options = catalog.items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase().trim()) ||
    String(item.id) === search.trim(),
  );
  const chosen = catalog.items.find((item) => item.id === Number(itemId));
  const visible = chosen && !options.some((item) => item.id === chosen.id)
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
    setBusy(true);
    const controller = new AbortController();
    try {
      const result = await client.addManual({
        itemId: chosen.id,
        collectorName: collectorName.trim(),
        collectedOn,
        hardcore,
        proofUrl: proofUrl.trim(),
        approve,
        reason: reason.trim(),
      }, session.csrfToken, controller.signal);
      setOpen(false);
      setCollectorName('');
      setProofUrl('');
      setReason('');
      onCreated(result);
    } catch (failure) {
      if (failure instanceof Error && 'status' in failure &&
          [401, 403].includes(Number(failure.status))) onAccessLost();
      else if (failure instanceof Error && 'status' in failure &&
          Number(failure.status) === 409 && approve)
        setError(
          chosen.name + ' is already collected in ' +
          (hardcore ? 'hardcore' : 'ordinary') +
          ' worlds. Revoke or edit the existing approved entry instead.',
        );
      else setError(failure instanceof Error ? failure.message : 'Could not create manual submission.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel">
      <div className="admin-section-heading">
        <div>
          <h2>Manual submission</h2>
          <p>Add a drop directly from the admin panel, without a Discord bot claim.</p>
        </div>
        <button className="site-button" type="button" onClick={() => setOpen(!open)}>
          {open ? 'Cancel manual entry' : 'Add manual submission'}
        </button>
      </div>
      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset className="admin-fieldset" disabled={busy}>
            <div className="admin-form-grid">
              <label>Search catalog items
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
              <label>Canonical item
                <select aria-label="Canonical item" required size={5} value={itemId} onChange={(event) => setItemId(event.target.value)}>
                  <option value="">Choose the exact item…</option>
                  {visible.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}
                </select>
              </label>
              <label>Collector name
                <input required maxLength={80} value={collectorName} onChange={(event) => setCollectorName(event.target.value)} />
              </label>
              <label>Collection date
                <input type="date" required max={new Date().toISOString().slice(0, 10)} value={collectedOn} onChange={(event) => setCollectedOn(event.target.value)} />
              </label>
              <label>Proof URL (optional)
                <input type="url" value={proofUrl} placeholder="https://imgur.com/…" onChange={(event) => setProofUrl(event.target.value)} />
              </label>
              <label>Reason or note (optional)
                <textarea maxLength={1000} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
            </div>
            <label className="admin-checkbox">
              <input type="checkbox" checked={hardcore} onChange={(event) => setHardcore(event.target.checked)} />
              Collected on hardcore worlds
            </label>
            <label className="admin-checkbox">
              <input type="checkbox" checked={approve} onChange={(event) => setApprove(event.target.checked)} />
              Approve immediately and show in the collection log
            </label>
            <p className="admin-note">Uncheck immediate approval to add to the pending review queue. Each item can only have one approved credit per world.</p>
            {error && <p role="alert" className="admin-error">{error}</p>}
            <button className="site-button" type="submit">{busy ? 'Saving…' : 'Create manual submission'}</button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
