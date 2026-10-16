/** Push navigation is committed only after preparation; native history keeps its entries. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { AdminNavigator } from './use-admin-routes.ts';
import { withAbort } from './with-abort.ts';
import { RouteCodeError } from './route-code.ts';

export interface SiteNavigation {
  route: { path: string };
  navigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  register: (navigator: AdminNavigator | null) => void;
}

function location() {
  return {
    path: window.location.pathname,
  };
}
function position() {
  return Number.isInteger(window.history.state?.clogPosition)
    ? Number(window.history.state.clogPosition)
    : 0;
}
export function useRouteNavigation<T>(
  prepare: (route: SiteNavigation['route'], signal: AbortSignal) => Promise<T>,
) {
  const [route, setRoute] = useState(() => ({
    ...location(),
    resources: undefined as T | undefined,
  }));
  const [pending, setPending] = useState<{
    error?: string;
    codeFailure?: boolean;
    retry: () => void;
    cancel: () => void;
  }>();
  const loading = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const visible = useRef({ href: window.location.href, position: position() });
  const browserPosition = useRef(position());
  const navigator = useRef<AdminNavigator | null>(null);
  const focusRequest = useRef<number[] | undefined>(undefined);
  const restoring = useRef<
    { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);
  const register = useCallback((next: AdminNavigator | null) => {
    navigator.current = next;
  }, []);
  const restore = useCallback(async () => {
    if (browserPosition.current === visible.current.position) return;
    await new Promise<void>((resolve) => {
      if (restoring.current) {
        const previous = restoring.current.resolve;
        restoring.current.resolve = () => {
          previous();
          resolve();
        };
        return;
      }
      const timer = setTimeout(() => {
        restoring.current = undefined;
        resolve();
      }, 2000);
      restoring.current = { resolve, timer };
      window.history.go(visible.current.position - browserPosition.current);
    });
  }, []);
  const request = useCallback(
    (
      href: string,
      kind: 'push' | 'replace' | 'pop' = 'push',
      targetPosition?: number,
      scroll?: number[],
    ) => {
      const stay = kind === 'push' && href === visible.current.href;
      if (stay && !navigator.current) return;
      const originFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      const restoreRequest = async () => {
        await restore();
        if (originFocus?.isConnected)
          originFocus.focus({ preventScroll: true });
      };
      let resources: T | undefined;
      const prepareRequest = async (signal: AbortSignal) => {
        const target = new URL(href);
        resources = await prepare(
          {
            path: target.pathname,
          },
          signal,
        );
      };
      const commit = async (apply: () => void, signal: AbortSignal) => {
        if (kind !== 'pop') await restore();
        if (signal.aborted) return;
        if (
          kind !== 'pop' &&
          browserPosition.current !== visible.current.position
        )
          throw new Error('History restoration failed.');
        if (kind === 'push') {
          window.history.replaceState(
            {
              ...window.history.state,
              clogScroll: [window.scrollX, window.scrollY],
            },
            '',
            visible.current.href,
          );
          const nextPosition = visible.current.position + 1;
          window.history.pushState(
            { clogPosition: nextPosition, clogScroll: [0, 0] },
            '',
            href,
          );
          browserPosition.current = nextPosition;
        } else if (kind === 'replace') {
          window.history.replaceState(
            { ...window.history.state, clogPosition: visible.current.position },
            '',
            href,
          );
        }
        visible.current = {
          href,
          position: targetPosition ?? browserPosition.current,
        };
        focusRequest.current = scroll ?? [0, 0];
        const target = new URL(href);
        setRoute({
          path: target.pathname,
          resources,
        });
        apply();
      };
      if (navigator.current)
        navigator.current({
          href,
          stay,
          prepare: prepareRequest,
          commit,
          restore: restoreRequest,
        });
      else {
        loading.current?.abort();
        const controller = new AbortController(),
          current = ++generation.current;
        loading.current = controller;
        const cancel = () => {
          generation.current++;
          controller.abort();
          setPending(undefined);
          void restoreRequest();
        };
        const retry = () => request(href, kind, targetPosition, scroll);
        setPending({ retry, cancel });
        const timer = setTimeout(() => controller.abort(), 10000);
        void withAbort(prepareRequest(controller.signal), controller.signal)
          .then(() => commit(() => setPending(undefined), controller.signal))
          .catch((failure: unknown) => {
            if (current !== generation.current) return;
            const timedOut = controller.signal.aborted;
            controller.abort();
            setPending({
              retry,
              cancel,
              codeFailure: failure instanceof RouteCodeError,
              error:
                failure instanceof RouteCodeError
                  ? failure.message
                  : timedOut
                    ? 'Loading timed out. Retry or cancel navigation.'
                    : 'This page could not be loaded. Retry or cancel navigation.',
            });
            void restoreRequest();
          })
          .finally(() => clearTimeout(timer));
      }
    },
    [prepare, restore],
  );
  useLayoutEffect(() => {
    const scroll = focusRequest.current;
    if (!scroll) return;
    focusRequest.current = undefined;
    const heading =
      document.querySelector<HTMLElement>('main h2') ??
      document.querySelector<HTMLElement>('main h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(scroll[0] ?? 0, scroll[1] ?? 0);
  }, [route]);
  useEffect(() => {
    const priorRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    window.history.replaceState(
      { ...window.history.state, clogPosition: visible.current.position },
      '',
      window.location.href,
    );
    const changed = () => {
      const targetPosition = position();
      browserPosition.current = targetPosition;
      if (restoring.current) {
        if (targetPosition === visible.current.position) {
          const current = restoring.current;
          restoring.current = undefined;
          clearTimeout(current.timer);
          current.resolve();
        }
        return;
      }
      request(
        window.location.href,
        'pop',
        targetPosition,
        window.history.state?.clogScroll,
      );
    };
    const scrolled = () => {
      // Native history can change the URL before its popstate notification.
      // Scroll bookkeeping must never restore the old address over that target.
      if (
        browserPosition.current === visible.current.position &&
        window.location.href === visible.current.href
      )
        window.history.replaceState(
          {
            ...window.history.state,
            clogScroll: [window.scrollX, window.scrollY],
          },
          '',
        );
    };
    window.addEventListener('popstate', changed);
    window.addEventListener('scroll', scrolled);
    return () => {
      window.history.scrollRestoration = priorRestoration;
      window.removeEventListener('popstate', changed);
      window.removeEventListener('scroll', scrolled);
      if (restoring.current) {
        clearTimeout(restoring.current.timer);
        restoring.current.resolve();
      }
    };
  }, [request]);
  useEffect(() => {
    request(window.location.href, 'replace');
    return () => {
      generation.current++;
      loading.current?.abort();
    };
  }, [request]);
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.currentTarget.target === '_blank'
    )
      return;
    const url = new URL(event.currentTarget.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    request(url.href);
  };
  return { route, navigate, register, pending };
}
