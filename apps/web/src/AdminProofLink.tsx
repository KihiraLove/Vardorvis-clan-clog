/** Show only validated external evidence links, without sending referrer or opener access. */
import { safeProof, type Submission } from './admin-model.ts';
export function ProofLink({ url, source }: { url: string; source: Submission['source'] }) {
  const safe = safeProof(url);
  if (source === 'manual' && !url.trim())
    return <span className="admin-note">No proof supplied (manual entry)</span>;
  return safe ? (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      Open proof on {new URL(safe).hostname}
    </a>
  ) : (
    <span className="admin-error">
      Invalid proof link — cannot approve this claim.
    </span>
  );
}
