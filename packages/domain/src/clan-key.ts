/** Generated clan keys use 128 random bits; custom keys preserve any characters. */
export const clanKeyBytes = 16;
export const clanKeyMinLength = 8;
export const validClanApiKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  Array.from(value).length >= clanKeyMinLength &&
  !/[\uD800-\uDFFF]/u.test(value);
