/** Saved screenshots stay on the private backend; external proof URLs are historical data only. */
import { safeScreenshotPath, type Submission } from './admin-model.ts';
export function ProofLink({
  source,
  screenshot,
  chatMessage,
}: {
  source: Submission['source'];
  screenshot?: string | null | undefined;
  chatMessage?: string | undefined;
}) {
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
          View screenshot
        </a>
      </div>
    );
  if (source === 'runelite' && chatMessage?.trim())
    return <span>Chat message proof</span>;
  if (source === 'manual')
    return <span className="admin-note">No proof supplied (manual entry)</span>;
  return (
    <span className="admin-error">
      No screenshot supplied — cannot approve this claim.
    </span>
  );
}
