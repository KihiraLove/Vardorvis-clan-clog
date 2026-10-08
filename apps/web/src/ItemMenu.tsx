/** Portal tooltip escapes the scaled/clipped log window and stays inside the viewport. */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { creditLine, type Credit, type Item } from './model.ts';

export interface OpenItem {
  item: Item;
  anchor: HTMLElement;
  collectors: Credit[];
  hardcore: boolean;
  pinned: boolean;
}
export function ItemMenu({
  open,
  close,
  stay,
  leave,
}: {
  open: OpenItem;
  close: () => void;
  stay: () => void;
  leave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  useLayoutEffect(() => {
    const place = () => {
      if (!open.anchor.isConnected) {
        close();
        return;
      }
      const anchor = open.anchor.getBoundingClientRect();
      const menu = ref.current?.getBoundingClientRect();
      if (!menu) return;
      const left = Math.max(
        8,
        Math.min(anchor.left, window.innerWidth - menu.width - 8),
      );
      const below = anchor.bottom + 6;
      const top = Math.max(
        8,
        Math.min(
          below + menu.height <= window.innerHeight - 8
            ? below
            : anchor.top - menu.height - 6,
          window.innerHeight - menu.height - 8,
        ),
      );
      setPosition({ left, top, ready: true });
    };
    place();
    // Credit changes can resize an already-open menu; scrolling can move its anchor.
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!open.anchor.contains(target) && !ref.current?.contains(target))
        close();
    };
    window.addEventListener('keydown', dismiss);
    window.addEventListener('pointerdown', outside);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('pointerdown', outside);
    };
  }, [open, close]);
  return createPortal(
    <div
      ref={ref}
      id={`item-menu-${open.item.id}`}
      role="tooltip"
      className={`item-menu${open.hardcore ? ' item-menu--hardcore' : ''}`}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
      onPointerEnter={stay}
      onPointerLeave={leave}
    >
      <div className="item-menu__heading">
        {open.hardcore && (
          <span className="skull" aria-label="Hardcore collection">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="#deded3"
                d="M4 1h8v2h2v7h-2v4h-2v1H6v-1H4v-4H2V3h2z"
              />
              <path
                fill="#151411"
                d="M4 5h3v3H4zm5 0h3v3H9zM7 9h2v2H7zM6 12h1v3H6zm3 0h1v3H9z"
              />
            </svg>
          </span>
        )}
        {open.item.name}
      </div>
      {open.collectors.length ? (
        open.collectors.map((credit) => (
          <p key={credit.submissionId}>{creditLine(credit)}</p>
        ))
      ) : (
        <p className="item-menu__empty">Not collected</p>
      )}
    </div>,
    document.body,
  );
}
