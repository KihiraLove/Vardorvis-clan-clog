/** Fixed-origin Discord identify exchange; credentials never leave this service's memory. */
import type { AuthConfig } from './config.js';
import { ApiError, type AdminIdentity } from './types.js';
export type Identify = (code: string) => Promise<AdminIdentity>;
export function discordIdentify(
  config: AuthConfig,
  request: typeof fetch = fetch,
): Identify {
  return async (code) => {
    const signal = AbortSignal.timeout(10000);
    const tokenResponse = await request(
      'https://discord.com/api/oauth2/token',
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      },
    );
    if (!tokenResponse.ok)
      throw new ApiError(
        502,
        'Discord sign-in could not be completed. Try signing in again.',
      );
    const token: unknown = await tokenResponse.json();
    if (
      !token ||
      typeof token !== 'object' ||
      !('access_token' in token) ||
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      !('token_type' in token) ||
      String(token.token_type).toLowerCase() !== 'bearer'
    )
      throw new ApiError(502, 'Invalid Discord token response.');
    const response = await request('https://discord.com/api/v10/users/@me', {
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    if (!response.ok)
      throw new ApiError(502, 'Discord identity could not be verified.');
    const user: unknown = await response.json();
    if (
      !user ||
      typeof user !== 'object' ||
      !('id' in user) ||
      typeof user.id !== 'string' ||
      !/^\d{17,20}$/u.test(user.id) ||
      !('username' in user) ||
      typeof user.username !== 'string' ||
      !user.username.trim()
    )
      throw new ApiError(502, 'Invalid Discord identity.');
    const name =
      'global_name' in user &&
      typeof user.global_name === 'string' &&
      user.global_name.trim()
        ? user.global_name
        : user.username;
    return { id: user.id, displayName: name.slice(0, 80) };
  };
}
