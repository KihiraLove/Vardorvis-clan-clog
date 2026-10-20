/** Persisted RGBA highlights; alpha affects the outline, never the item sprite. */
export interface HighlightColour {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}
export interface HighlightUpdate {
  eventHighlight?: HighlightColour;
  hardcoreHighlight?: HighlightColour;
}
export const defaultEventHighlight: HighlightColour = {
  red: 231,
  green: 189,
  blue: 82,
  alpha: 1,
};
export const defaultHardcoreHighlight: HighlightColour = {
  red: 255,
  green: 41,
  blue: 41,
  alpha: 1,
};
export function parseHighlightColour(value: unknown): HighlightColour {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid highlight colour.');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    ['red', 'green', 'blue'].some(
      (key) =>
        typeof data[key] !== 'number' ||
        !Number.isInteger(data[key]) ||
        data[key] < 0 ||
        data[key] > 255,
    ) ||
    typeof data.alpha !== 'number' ||
    !Number.isFinite(data.alpha) ||
    data.alpha < 0 ||
    data.alpha > 1
  )
    throw new Error(
      'Highlight RGB channels must be integers from 0 to 255; alpha must be from 0 to 1.',
    );
  return {
    red: data.red as number,
    green: data.green as number,
    blue: data.blue as number,
    alpha: data.alpha,
  };
}
export const highlightCss = (colour: HighlightColour): string =>
  `rgba(${colour.red}, ${colour.green}, ${colour.blue}, ${colour.alpha})`;
