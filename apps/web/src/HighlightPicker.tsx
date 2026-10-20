import {
  highlightCss,
  parseHighlightColour,
  type HighlightColour,
} from '@clog/domain';

export interface HighlightDraft {
  hex: string;
  alpha: string;
}
export const highlightDraft = (value: HighlightColour): HighlightDraft => ({
  hex:
    '#' +
    [value.red, value.green, value.blue]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join(''),
  alpha: String(Number((value.alpha * 100).toFixed(8))),
});
export function draftHighlight(
  value: HighlightDraft,
): HighlightColour | undefined {
  if (!/^#?[a-f0-9]{6}$/iu.test(value.hex) || !value.alpha.trim()) return;
  const hex = value.hex.replace(/^#/u, '');
  try {
    return parseHighlightColour({
      red: parseInt(hex.slice(0, 2), 16),
      green: parseInt(hex.slice(2, 4), 16),
      blue: parseInt(hex.slice(4, 6), 16),
      alpha: Number(value.alpha) / 100,
    });
  } catch {
    return;
  }
}
/** The transparency swatch opens the native RGB picker; HEX and alpha stay editable. */
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
  const hexValid = /^#?[a-f0-9]{6}$/iu.test(value.hex);
  const hex = hexValid
    ? '#' + value.hex.replace(/^#/u, '').toLowerCase()
    : '#000000';
  return (
    <fieldset className="highlight-picker" disabled={disabled}>
      <legend>{title}</legend>
      <div className="highlight-picker__controls">
        <label>
          Colour
          <span className="highlight-picker__preview">
            <span
              style={{
                backgroundColor: colour ? highlightCss(colour) : 'transparent',
              }}
            />
            <input
              type="color"
              aria-label="Choose highlight colour"
              value={hex}
              onChange={(event) =>
                onChange({ ...value, hex: event.target.value })
              }
            />
          </span>
        </label>
        <label>
          HEX
          <input
            required
            type="text"
            className="highlight-picker__hex"
            placeholder="#RRGGBB"
            maxLength={7}
            pattern="#?[a-fA-F0-9]{6}"
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={!hexValid || undefined}
            value={value.hex}
            onChange={(event) =>
              onChange({ ...value, hex: event.target.value })
            }
          />
        </label>
        <label>
          Alpha (%)
          <input
            required
            type="number"
            min="0"
            max={100}
            step="any"
            value={value.alpha}
            onChange={(event) =>
              onChange({ ...value, alpha: event.target.value })
            }
          />
        </label>
      </div>
      {!colour && (
        <p role="alert">Use a six-digit HEX colour and Alpha from 0 to 100%.</p>
      )}
    </fieldset>
  );
}
