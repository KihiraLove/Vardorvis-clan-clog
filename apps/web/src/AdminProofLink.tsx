import { safeProof } from './admin-model.ts';
export function ProofLink({ url }: { url: string }) {
  const safe = safeProof(url);
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
