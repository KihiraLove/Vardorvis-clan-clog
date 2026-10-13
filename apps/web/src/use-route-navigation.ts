/** Push navigation is committed only after preparation; native history keeps its entries. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { AdminNavigator } from './use-admin-routes.ts';

function location() {
  return {
    path: window.location.pathname,
    preview: new URLSearchParams(window.location.search).get('preview') === '1',
  };
}
function position() {
  return Number.isInteger(window.history.state?.clogPosition)
    ? Number(window.history.state.clogPosition)
    : 0;
}
export function useRouteNavigation() {
  const [route, setRoute] = useState(location);
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
        setRoute(location());
        apply();
      };
      if (navigator.current)
        navigator.current({ href, stay, commit, restore: restoreRequest });
      else void commit(() => {}, new AbortController().signal);
    },
    [restore],
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
      if (browserPosition.current === visible.current.position)
        window.history.replaceState(
          {
            ...window.history.state,
            clogScroll: [window.scrollX, window.scrollY],
          },
          '',
          visible.current.href,
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
  const mode = (preview: boolean) => {
    const url = new URL(visible.current.href);
    if (preview) url.searchParams.set('preview', '1');
    else url.searchParams.delete('preview');
    request(url.href, 'replace');
  };
  return { route, navigate, mode, register };
}
