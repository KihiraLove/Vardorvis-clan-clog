import {
  highlightCss,
  parseHighlightColour,
  type HighlightColour,
} from '@clog/domain';

export type HighlightDraft = Record<keyof HighlightColour, string>;
export const highlightDraft = (value: HighlightColour): HighlightDraft => ({
  red: String(value.red),
  green: String(value.green),
  blue: String(value.blue),
  alpha: String(Number((value.alpha * 100).toFixed(8))),
});
export function draftHighlight(
  value: HighlightDraft,
): HighlightColour | undefined {
  if (Object.values(value).some((channel) => !channel.trim())) return;
  try {
    return parseHighlightColour({
      red: Number(value.red),
      green: Number(value.green),
      blue: Number(value.blue),
      alpha: Number(value.alpha) / 100,
    });
  } catch {
    return;
  }
}
/** The native colour box chooses RGB; numeric channels also control transparency. */
export function HighlightPicker({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: HighlightDraft;
  onChange: (value: HighlightDraft) => void;
  disabled: boolean;
}) {
  const colour = draftHighlight(value);
  const hex =
    '#' +
    (['red', 'green', 'blue'] as const)
      .map((key) =>
        Math.round(Math.max(0, Math.min(255, Number(value[key]) || 0)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  return (
    <fieldset className="highlight-picker" disabled={disabled}>
      <legend>{title}</legend>
      <div className="highlight-picker__controls">
        <label>
          Colour box
          <input
            type="color"
            value={hex}
            onChange={(event) => {
              const hex = event.target.value;
              onChange({
                ...value,
                red: String(parseInt(hex.slice(1, 3), 16)),
                green: String(parseInt(hex.slice(3, 5), 16)),
                blue: String(parseInt(hex.slice(5, 7), 16)),
              });
            }}
          />
        </label>
        <div
          className="highlight-picker__preview"
          aria-label="Highlight preview"
        >
          <span
            style={{
              backgroundColor: colour ? highlightCss(colour) : 'transparent',
            }}
          />
        </div>
        {(
          [
            ['red', 'Red'],
            ['green', 'Green'],
            ['blue', 'Blue'],
            ['alpha', 'Alpha (%)'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              required
              type="number"
              min="0"
              max={key === 'alpha' ? 100 : 255}
              step={key === 'alpha' ? 'any' : 1}
              value={value[key]}
              onChange={(event) =>
                onChange({ ...value, [key]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      {!colour && (
        <p role="alert">
          Use whole RGB values from 0 to 255 and Alpha from 0 to 100%.
        </p>
      )}
    </fieldset>
  );
}
