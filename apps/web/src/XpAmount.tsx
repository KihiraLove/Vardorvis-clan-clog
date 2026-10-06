import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  exactXp,
  millionXp,
  skillIcon,
  type SkillId,
  type Xp,
} from './xp-model.ts';

function ExactTooltip({
  anchor,
  label,
  xp,
  id,
}: {
  anchor: HTMLElement;
  label: string;
  xp: Xp;
  id: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    const place = () => {
      const bounds = anchor.getBoundingClientRect(),
        menu = ref.current?.getBoundingClientRect();
      if (!menu) return;
      setPosition({
        left: Math.max(
          12,
          Math.min(bounds.left, window.innerWidth - menu.width - 12),
        ),
        top: Math.max(
          12,
          Math.min(bounds.bottom + 6, window.innerHeight - menu.height - 12),
        ),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, xp]);
  return createPortal(
    <div
      className="xp-tooltip"
      id={id}
      role="tooltip"
      ref={ref}
      style={position}
    >
      <strong>{label}</strong>
      <span>{exactXp(xp)} XP</span>
      <small>Recorded competition gains</small>
    </div>,
    document.body,
  );
}
export function XpAmount({
  xp,
  label,
  skill,
  selected,
  onSelect,
}: {
  xp: Xp | null;
  label: string;
  skill?: SkillId;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const events = {
    onPointerEnter: () => setOpen(true),
    onPointerLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        event.stopPropagation();
      }
    },
    onClick: () => {
      setOpen(true);
      onSelect?.();
    },
  };
  const content = (
    <>
      {skill && <img src={skillIcon(skill)} alt="" draggable="false" />}
      <span className="xp-amount__body">
        {skill && <span className="skill-cell__name">{label}</span>}
        <span className="xp-amount__number">
          {xp === null ? '—' : millionXp(xp)}
        </span>
      </span>
    </>
  );
  const accessible =
    label + ': ' + (xp === null ? 'XP unavailable' : exactXp(xp) + ' XP');
  const described = open && xp !== null ? tooltipId : undefined;
  return (
    <>
      {onSelect ? (
        <button
          type="button"
          className="skill-cell"
          ref={(node) => {
            anchor.current = node;
          }}
          aria-label={accessible}
          aria-pressed={selected}
          aria-describedby={described}
          {...events}
        >
          {content}
        </button>
      ) : (
        <span
          tabIndex={0}
          className="xp-amount"
          ref={(node) => {
            anchor.current = node;
          }}
          aria-label={accessible}
          aria-describedby={described}
          {...events}
        >
          {content}
        </span>
      )}
      {open && xp !== null && anchor.current && (
        <ExactTooltip
          anchor={anchor.current}
          label={label}
          xp={xp}
          id={tooltipId}
        />
      )}
    </>
  );
}
