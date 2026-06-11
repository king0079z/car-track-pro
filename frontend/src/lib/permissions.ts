import type { User, UserRole } from '../types';

/** Page keys — must match backend `permissions.ALL_PAGE_KEYS`. */
export type PageKey =
  | 'dashboard'
  | 'visits'
  | 'vehicles'
  | 'fleet'
  | 'services'
  | 'analytics'
  | 'visionflow'
  | 'visionflow_multicam'
  | 'users'
  | 'audit'
  | 'settings';

export const PAGE_LABELS: Record<PageKey, string> = {
  dashboard: 'Dashboard',
  visits: 'Work orders / Visits',
  vehicles: 'Vehicles',
  fleet: 'Fleet intelligence',
  services: 'Services catalog',
  analytics: 'Analytics',
  visionflow: 'ANPR & speed',
  visionflow_multicam: 'Camera wall',
  users: 'Team users',
  audit: 'Audit log',
  settings: 'Settings',
};

export const DEFAULT_PAGES_BY_ROLE: Record<UserRole, PageKey[]> = {
  admin: Object.keys(PAGE_LABELS) as PageKey[],
  manager: (Object.keys(PAGE_LABELS) as PageKey[]).filter(k => k !== 'settings'),
  staff: ['visits'],
  viewer: ['dashboard', 'visits', 'vehicles'],
};

export interface NavItem {
  to: string;
  label: string;
  pageKey: PageKey;
  end?: boolean;
  adminOnly?: boolean;
  adminRoleOnly?: boolean;
}

export const NAV_MAIN: NavItem[] = [
  { to: '/', label: 'Dashboard', pageKey: 'dashboard', end: true },
  { to: '/visits', label: 'Visits', pageKey: 'visits' },
  { to: '/vehicles', label: 'Vehicles', pageKey: 'vehicles' },
  { to: '/fleet-intelligence', label: 'Fleet intelligence', pageKey: 'fleet' },
  { to: '/services', label: 'Services', pageKey: 'services' },
  { to: '/analytics', label: 'Analytics', pageKey: 'analytics' },
  { to: '/visionflow', label: 'ANPR & speed', pageKey: 'visionflow' },
  { to: '/visionflow/multicam', label: 'Camera wall', pageKey: 'visionflow_multicam' },
];

export const NAV_ADMIN: NavItem[] = [
  { to: '/users', label: 'Users', pageKey: 'users', adminOnly: true },
  { to: '/audit', label: 'Audit Log', pageKey: 'audit', adminOnly: true },
  { to: '/settings', label: 'Settings', pageKey: 'settings', adminRoleOnly: true },
];

/** Longest-prefix match for nested routes (e.g. /visits/new → visits). */
const ROUTE_PAGE_MAP: { prefix: string; pageKey: PageKey }[] = [
  { prefix: '/visits', pageKey: 'visits' },
  { prefix: '/vehicles', pageKey: 'vehicles' },
  { prefix: '/fleet-intelligence', pageKey: 'fleet' },
  { prefix: '/services', pageKey: 'services' },
  { prefix: '/analytics', pageKey: 'analytics' },
  { prefix: '/visionflow/multicam', pageKey: 'visionflow_multicam' },
  { prefix: '/visionflow/history', pageKey: 'visionflow' },
  { prefix: '/visionflow', pageKey: 'visionflow' },
  { prefix: '/users', pageKey: 'users' },
  { prefix: '/audit', pageKey: 'audit' },
  { prefix: '/settings', pageKey: 'settings' },
  { prefix: '/', pageKey: 'dashboard' },
];

export function effectivePages(user: User | null | undefined): PageKey[] {
  if (!user) return [];
  if (user.allowed_pages?.length) return user.allowed_pages as PageKey[];
  return DEFAULT_PAGES_BY_ROLE[user.role] ?? ['visits'];
}

export function canAccessPage(user: User | null | undefined, pageKey: PageKey): boolean {
  return effectivePages(user).includes(pageKey);
}

export function pageKeyForPath(pathname: string): PageKey {
  const path = pathname.split('?')[0];
  for (const { prefix, pageKey } of ROUTE_PAGE_MAP) {
    if (prefix === '/') {
      if (path === '/') return pageKey;
      continue;
    }
    if (path === prefix || path.startsWith(`${prefix}/`)) return pageKey;
  }
  return 'dashboard';
}

export function canAccessRoute(user: User | null | undefined, pathname: string): boolean {
  const key = pageKeyForPath(pathname);
  if (!canAccessPage(user, key)) return false;
  if (key === 'settings' && user?.role !== 'admin') return false;
  if ((key === 'users' || key === 'audit') && user && !['admin', 'manager'].includes(user.role)) {
    return canAccessPage(user, key);
  }
  return true;
}

export function getHomeRoute(user: User | null | undefined): string {
  const pages = effectivePages(user);
  if (pages.includes('dashboard')) return '/';
  if (pages.includes('visits')) return '/visits';
  const first = NAV_MAIN.find(n => pages.includes(n.pageKey));
  return first?.to ?? '/visits';
}

export function isOrgWideUser(user: User | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'manager';
}

export function filterNavItems(items: NavItem[], user: User | null | undefined): NavItem[] {
  const pages = effectivePages(user);
  return items.filter(item => {
    if (item.adminRoleOnly && user?.role !== 'admin') return false;
    if (item.adminOnly && user && !['admin', 'manager'].includes(user.role) && !pages.includes(item.pageKey)) {
      return false;
    }
    return pages.includes(item.pageKey);
  });
}
