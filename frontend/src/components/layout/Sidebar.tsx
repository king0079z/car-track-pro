import React, { useCallback, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Car, ClipboardList, BarChart3, Gauge,
  Users, Settings, LogOut, Wrench, Shield,
  Sun, Moon, Grid2X2, Brain, X, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { NAV_MAIN, NAV_ADMIN, filterNavItems } from '../../lib/permissions';

const ICONS: Record<string, typeof Users> = {
  dashboard: LayoutDashboard,
  visits: ClipboardList,
  vehicles: Car,
  fleet: Brain,
  services: Wrench,
  analytics: BarChart3,
  visionflow: Gauge,
  visionflow_multicam: Grid2X2,
  users: Users,
  audit: Shield,
  settings: Settings,
};

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ open = false, onClose }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { toggle, isDark } = useTheme();
  const mainNav = filterNavItems(NAV_MAIN, user);
  const adminNav = filterNavItems(NAV_ADMIN, user);
  const touchStartX = useRef<number | null>(null);

  const handleNavClick = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const handleLogout = useCallback(() => {
    onClose?.();
    logout();
    navigate('/login');
  }, [logout, navigate, onClose]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = touchStartX.current;
    if (start == null) return;
    const end = e.changedTouches[0]?.clientX ?? start;
    if (end - start < -72) onClose?.();
    touchStartX.current = null;
  }, [onClose]);

  const renderNavLink = (item: typeof NAV_MAIN[number]) => {
    const Icon = ICONS[item.pageKey] ?? ClipboardList;
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={handleNavClick}
        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      >
        <span className="nav-item-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="nav-item-label">{item.label}</span>
        <ChevronRight size={16} className="nav-item-chevron" aria-hidden="true" />
      </NavLink>
    );
  };

  return (
    <aside
      className={`sidebar${open ? ' open' : ''}`}
      aria-hidden={!open ? true : undefined}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="mobile-drawer-accent" aria-hidden="true" />
      <div className="mobile-drawer-handle" aria-hidden="true" />

      <div className="mobile-drawer-header">
        <div className="mobile-drawer-user">
          <div className="mobile-drawer-avatar">{user?.full_name?.[0]?.toUpperCase()}</div>
          <div className="mobile-drawer-user-text">
            <div className="mobile-drawer-user-name">{user?.full_name}</div>
            <div className="mobile-drawer-user-role">{user?.role}</div>
          </div>
        </div>
        <button
          type="button"
          className="nav-toggle nav-toggle--close mobile-drawer-close"
          onClick={onClose}
          aria-label="Close menu"
        >
          <X size={20} strokeWidth={2.25} />
        </button>
      </div>

      <div className="sidebar-logo">
        <div className="sidebar-brand-row">
          <div className="sidebar-brand-mark">
            <Car size={18} color="white" />
          </div>
          <div>
            <div className="sidebar-brand-title">CarTrack Pro</div>
            <div className="sidebar-brand-sub">AI Monitoring System</div>
          </div>
        </div>
        <div className="sidebar-live-pill">
          <span className="sidebar-live-dot" />
          <span>System Live</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {mainNav.length > 0 && (
          <>
            <div className="nav-section-label">Main menu</div>
            {mainNav.map(renderNavLink)}
          </>
        )}

        {adminNav.length > 0 && (
          <>
            <div className="nav-section-label nav-section-label--admin">Administration</div>
            {adminNav.map(renderNavLink)}
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="mobile-theme-toggle"
          onClick={toggle}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="mobile-theme-toggle-left">
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
            <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
          </span>
          <span className={`mobile-theme-switch${isDark ? ' on' : ''}`} aria-hidden="true">
            <span className="mobile-theme-switch-knob" />
          </span>
        </button>

        <button type="button" className="mobile-sign-out" onClick={handleLogout}>
          <LogOut size={18} />
          <span>Sign out</span>
        </button>

        <div className="user-card desktop-only-user" onClick={handleLogout}>
          <div className="user-avatar">{user?.full_name?.[0]?.toUpperCase()}</div>
          <div className="user-card-text">
            <div className="user-card-name">{user?.full_name}</div>
            <div className="user-card-role">{user?.role}</div>
          </div>
          <LogOut size={14} color="var(--text-muted)" />
        </div>
      </div>
    </aside>
  );
};
