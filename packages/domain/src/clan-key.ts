/** A shared clan key is 128 random bits written as exactly 32 hexadecimal characters. */
export const clanKeyBytes = 16;
export const clanKeyPattern = '^[a-fA-F0-9]{32}$';
export const validClanApiKey = (value: unknown): value is string =>
  typeof value === 'string' && new RegExp(clanKeyPattern, 'u').test(value);
