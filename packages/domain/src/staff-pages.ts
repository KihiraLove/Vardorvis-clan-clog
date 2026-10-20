/** Page access is independent of administrator-only actions within a page. */
export const staffPages = [
  { id: 'submissions', label: 'Submissions', path: '/admin' },
  { id: 'catalog', label: 'Items catalog', path: '/admin/catalog' },
  {
    id: 'schedules',
    label: 'Scheduling and Competitions',
    path: '/admin/schedules',
  },
  { id: 'runelite', label: 'RuneLite submissions', path: '/admin/runelite' },
  { id: 'settings', label: 'Site settings', path: '/admin/settings' },
  {
    id: 'hardcore',
    label: 'Hardcore worlds',
    path: '/admin/settings/hardcore',
  },
  { id: 'discord', label: 'Discord bot', path: '/admin/discord' },
] as const;
export type StaffPage = (typeof staffPages)[number]['id'];
export const defaultModeratorPages: readonly StaffPage[] = [
  'submissions',
  'catalog',
  'schedules',
  'runelite',
];
export interface AccessControlSettings {
  revision: string;
  moderatorPages: StaffPage[];
}
export function parseStaffPages(value: unknown): StaffPage[] {
  if (
    !Array.isArray(value) ||
    value.length > staffPages.length ||
    value.some((id) => !staffPages.some((page) => page.id === id)) ||
    new Set(value).size !== value.length
  )
    throw new Error('Choose valid moderator pages without duplicates.');
  return staffPages
    .filter((page) => value.includes(page.id))
    .map((page) => page.id);
}
export function parseAccessControl(value: unknown): AccessControlSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid access control settings.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.revision !== 'string' ||
    !/^access-control-[1-9][0-9]{0,9}$/u.test(data.revision)
  )
    throw new Error('Invalid access control revision.');
  return {
    revision: data.revision,
    moderatorPages: parseStaffPages(data.moderatorPages),
  };
}
export function staffPageForPath(path: string): StaffPage | undefined {
  if (path === '/admin/xp') return 'schedules';
  return staffPages.find((page) => page.path === path)?.id;
}
export function canAccessStaffPage(
  session: { role: 'admin' | 'moderator'; allowedPages?: readonly StaffPage[] },
  page: StaffPage,
) {
  return (
    session.role === 'admin' ||
    (session.allowedPages ?? defaultModeratorPages).includes(page)
  );
}
