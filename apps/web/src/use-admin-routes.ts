import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession, XpClient } from './xp-model.ts';
import { classifyAccessFailure } from './admin-session.ts';
import { withAbort } from './with-abort.ts';
import {
  isAdminPath,
  loadAdminRoute,
  type AdminDraft,
  type PreparedAdminData,
} from './admin-route-data.ts';

export interface AdminNavigationRequest {
  href: string;
  stay?: boolean;
  /** Apply prepared data in the same update as visible route and history. */
  commit: (apply: () => void, signal: AbortSignal) => Promise<void>;
  restore: () => Promise<void>;
}
export type AdminNavigator = (request: AdminNavigationRequest) => void;
export function useAdminRoutes({
  path,
  preview,
  session,
  client,
  xp,
  onAccessLost,
  register,
}: {
  path: string;
  preview: boolean;
  session: AdminSession | null;
  client: AdminClient;
  xp: XpClient;
  onAccessLost: () => void;
  register: (navigator: AdminNavigator | null) => void;
}) {
  const [ready, setReady] = useState<{
    path: string;
    data: PreparedAdminData;
    session: AdminSession;
  }>();
  const [pending, setPending] = useState<{
    request: AdminNavigationRequest;
    label: string;
    error?: string;
  }>();
  const drafts = useRef(new Map<string, AdminDraft>());
  const generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const stop = useCallback(() => {
    generation.current++;
    controller.current?.abort();
  }, []);
  const cancel = useCallback(() => {
    stop();
    const request = pendingRef.current?.request;
    setPending(
      !readyRef.current && request
        ? {
            request,
            label: pendingRef.current!.label,
            error: 'Loading cancelled. Retry navigation to load this page.',
          }
        : undefined,
    );
    void request?.restore();
  }, [stop]);
  const start = useCallback(
    (request: AdminNavigationRequest) => {
      if (request.stay) {
        cancel();
        return;
      }
      stop();
      const current = generation.current;
      const next = new AbortController();
      controller.current = next;
      const url = new URL(request.href, window.location.href);
      const target = url.pathname;
      const label = isAdminPath(target) ? target : 'collection log';
      setPending({ request, label });
      const timer = setTimeout(
        () => next.abort(new Error('Navigation timed out.')),
        10000,
      );
      void withAbort(
        isAdminPath(target) &&
          session &&
          (url.searchParams.get('preview') === '1') === preview
          ? loadAdminRoute(target, session, client, xp, next.signal)
          : Promise.resolve(undefined),
        next.signal,
      )
        .then(async (data) => {
          if (current !== generation.current || next.signal.aborted) return;
          if ([...drafts.current.values()].some((draft) => draft.busy))
            throw new Error('A staff operation is still running.');
          if (
            [...drafts.current.values()].some((draft) => draft.dirty) &&
            !window.confirm('Discard unsaved changes and leave this page?')
          ) {
            cancel();
            return;
          }
          await request.commit(() => {
            setReady(
              data && session ? { path: target, data, session } : undefined,
            );
            setPending(undefined);
          }, next.signal);
        })
        .catch((failure: unknown) => {
          if (current !== generation.current) return;
          if (classifyAccessFailure(failure) === 'expired') {
            stop();
            setReady(undefined);
            setPending(undefined);
            onAccessLost();
            void request.restore();
          } else {
            setPending({
              request,
              label,
              error: next.signal.aborted
                ? 'Loading timed out. Retry or cancel navigation.'
                : classifyAccessFailure(failure) === 'denied'
                  ? target === '/admin/xp'
                    ? 'Your account is not allowed to view XP import history.'
                    : 'Your account is not allowed to view this page.'
                  : failure instanceof Error &&
                      failure.message === 'A staff operation is still running.'
                    ? 'Wait for the current staff operation to finish, then retry or cancel navigation.'
                    : 'This page could not be loaded. Retry or cancel navigation.',
            });
          }
        })
        .finally(() => clearTimeout(timer));
    },
    [cancel, client, onAccessLost, preview, session, stop, xp],
  );
  useEffect(() => {
    register(start);
    return () => {
      register(null);
      stop();
    };
  }, [register, start, stop]);
  useEffect(() => {
    if (!session) {
      stop();
      setReady(undefined);
      setPending(undefined);
      drafts.current.clear();
      return;
    }
    if (ready?.path === path && ready.session === session) return;
    start({
      href: window.location.href,
      commit: async (apply, signal) => {
        if (!signal.aborted) apply();
      },
      restore: async () => {},
    });
  }, [path, ready, session, start, stop]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (
        [...drafts.current.values()].some((draft) => draft.dirty || draft.busy)
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);
  return {
    ready,
    pending,
    drafts: drafts.current,
    cancel,
    retry: () => {
      if (pending) start(pending.request);
    },
  };
}
