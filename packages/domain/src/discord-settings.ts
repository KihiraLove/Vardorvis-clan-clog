/** Public Discord settings never contain either service credential. */
export const defaultDiscordLimits = {
  intakeUser: 5,
  intakeGuild: 60,
  searchUser: 30,
  searchGuild: 300,
};
export type DiscordLimits = typeof defaultDiscordLimits;
export interface DiscordFields {
  enabled: boolean;
  applicationId: string;
  guildId: string;
  testGuildId: string;
  limits: DiscordLimits;
}
export interface DiscordSettings extends DiscordFields {
  revision: string;
  tokenConfigured: boolean;
}
export interface DiscordSettingsUpdate extends DiscordFields {
  expectedRevision: string;
  token?: string;
}
export const discordSnowflake = /^\d{17,20}$/u;
export function parseDiscordFields(input: unknown): DiscordFields {
  const value = input as DiscordFields;
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean')
    throw new Error('Invalid Discord settings.');
  for (const id of [value.applicationId, value.guildId, value.testGuildId]) {
    if (typeof id !== 'string' || (id !== '' && !discordSnowflake.test(id)))
      throw new Error('Discord IDs must contain 17–20 digits.');
  }
  if (value.enabled && (!value.applicationId || !value.guildId))
    throw new Error(
      'Application and server IDs are required to enable Discord.',
    );
  const limits = {} as DiscordLimits;
  for (const [key, maximum] of [
    ['intakeUser', 120],
    ['intakeGuild', 120],
    ['searchUser', 600],
    ['searchGuild', 600],
  ] as const) {
    const number = value.limits?.[key];
    if (!Number.isInteger(number) || number < 1 || number > maximum)
      throw new Error('Discord rate limits are outside the allowed range.');
    limits[key] = number;
  }
  return {
    enabled: value.enabled,
    applicationId: value.applicationId,
    guildId: value.guildId,
    testGuildId: value.testGuildId,
    limits,
  };
}
export function parseDiscordSettings(input: unknown): DiscordSettings {
  const value = input as DiscordSettings;
  const fields = parseDiscordFields(input);
  if (
    !/^discord-[1-9]\d*$/u.test(value.revision) ||
    typeof value.tokenConfigured !== 'boolean' ||
    (fields.enabled && !value.tokenConfigured)
  )
    throw new Error('Invalid Discord settings receipt.');
  return {
    ...fields,
    revision: value.revision,
    tokenConfigured: value.tokenConfigured,
  };
}
