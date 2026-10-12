/** Only generated same-origin raster paths may be supplied by the live branding API. */
export interface Branding {
  revision: string;
  logoPath: string;
  faviconPath: string;
}
export const defaultBranding: Branding = {
  revision: 'branding-1',
  logoPath: '/brand/clan-logo.png',
  faviconPath: '/favicon.png',
};
export function parseBranding(value: unknown): Branding {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid clan branding.');
  const data = value as Record<string, unknown>;
  const id =
    '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  const match =
    typeof data.logoPath === 'string'
      ? new RegExp('^/api/v1/branding/(' + id + ')\\.webp$', 'u').exec(
          data.logoPath,
        )
      : null;
  if (
    typeof data.revision !== 'string' ||
    !/^branding-[1-9][0-9]*$/u.test(data.revision) ||
    data.revision.length > 40 ||
    !(
      (data.logoPath === defaultBranding.logoPath &&
        data.faviconPath === defaultBranding.faviconPath) ||
      (match && data.faviconPath === `/api/v1/branding/${match[1]}/favicon.png`)
    )
  )
    throw new Error('Invalid clan branding.');
  return {
    revision: data.revision,
    logoPath: data.logoPath as string,
    faviconPath: data.faviconPath as string,
  };
}
export function validateLogoFile(file: File) {
  // The server detects format from the contents, including images without browser MIME metadata.
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error('Choose a logo up to 10 MiB.');
}
