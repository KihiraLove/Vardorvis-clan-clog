/** Show only validated external evidence links, without sending referrer or opener access. */
import {
  safeProof,
  safeScreenshotPath,
  type Submission,
} from './admin-model.ts';
export function ProofLink({
  url,
  source,
  screenshot,
  previewScreenshot,
  chatMessage,
}: {
  url: string;
  source: Submission['source'];
  screenshot?: string | null | undefined;
  previewScreenshot?: string | undefined;
  chatMessage?: string | undefined;
}) {
  const safe = safeProof(url);
  if (previewScreenshot?.startsWith('data:image/png;base64,'))
    return (
      <div className="submission-proof">
        <img src={previewScreenshot} alt="Submission screenshot" />
        <span>PNG screenshot (preview)</span>
      </div>
    );
  if (safeScreenshotPath(screenshot))
    return (
      <div className="submission-proof">
        <a
          href={screenshot}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          <img src={screenshot} alt="Submission screenshot" loading="lazy" />
          View PNG screenshot
        </a>
        {safe && (
          <a href={safe} target="_blank" rel="noopener noreferrer">
            Open external proof
          </a>
        )}
      </div>
    );
  if (source === 'runelite' && chatMessage?.trim() && !safe)
    return <span>Chat message proof</span>;
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
