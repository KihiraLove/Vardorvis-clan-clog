/** Serialize form operations, bound their duration and centralize access/conflict errors. */
import { withAbort } from './with-abort.ts';
import { useEffect, useRef, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';

export function useAdminAction(onAccessLost: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = undefined;
    },
    [],
  );
  const execute = async (
    work: (signal: AbortSignal) => Promise<void>,
    conflict?: (signal: AbortSignal) => Promise<void>,
  ) => {
    // A ref closes the double-click gap before React renders the disabled busy state.
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    const timer = window.setTimeout(() => current.abort(), 15000);
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await withAbort(work(current.signal), current.signal);
    } catch (failure) {
      if (controller.current !== current) return;
      if (
        failure instanceof AdminRequestError &&
        [401, 403].includes(failure.status)
      )
        onAccessLost();
      else {
        setError(
          current.signal.aborted
            ? 'The request timed out. Reload or retry to check the result.'
            : failure instanceof AdminRequestError
              ? failure.message
              : failure instanceof Error
                ? failure.message
                : 'The admin request could not be completed.',
        );
        // A conflict may reload current state, but never silently replays the write.
        if (
          failure instanceof AdminRequestError &&
          failure.status === 409 &&
          conflict
        ) {
          try {
            await conflict(current.signal);
            if (controller.current === current && !current.signal.aborted)
              setError(
                failure.message ===
                  'Another change was saved. Load the latest data before trying again.'
                  ? 'Another change was saved. The latest data is loaded; review it before trying again.'
                  : failure.message +
                      ' The latest data is loaded; review the credit before trying again.',
              );
          } catch (failure) {
            if (
              failure instanceof AdminRequestError &&
              [401, 403].includes(failure.status)
            )
              onAccessLost();
            else
              setError(
                'The data changed, but the latest version could not be loaded. Reload before continuing.',
              );
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (controller.current === current) {
        controller.current = undefined;
        setBusy(false);
      }
    }
  };
  return { busy, error, message, execute, setMessage, setError };
}
