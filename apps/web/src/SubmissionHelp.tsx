/** Native top-layer dialog preserves the current route, selection and page scroll. */
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { defaultSubmissionHelp } from '@clog/domain';

const HelpMarkdown = lazy(() => import('./HelpMarkdown.tsx'));

class HelpLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p>
        Instructions could not be displayed. Please ask your clan staff for
        submission help.
      </p>
    ) : (
      this.props.children
    );
  }
}

export function SubmissionHelpContent({ text }: { text: string }) {
  return (
    <HelpLoadBoundary>
      <Suspense fallback={<p role="status">Loading instructions…</p>}>
        <HelpMarkdown text={text.trim() ? text : defaultSubmissionHelp} />
      </Suspense>
    </HelpLoadBoundary>
  );
}

export function SubmissionHelp({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    const x = window.scrollX,
      y = window.scrollY;
    element.showModal();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
      window.scrollTo(x, y);
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="submission-help-dialog"
      aria-labelledby="submission-help-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), [tabindex="0"]',
          ),
        );
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="submission-help-heading">
        <h2 id="submission-help-title">How to submit</h2>
        <button
          type="button"
          className="site-button"
          aria-label="Close submission help"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div
        className="submission-help-body"
        role="region"
        tabIndex={0}
        aria-label="Submission instructions"
      >
        <SubmissionHelpContent text={text} />
      </div>
    </dialog>
  );
}
