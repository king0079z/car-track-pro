import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Car, ClipboardList, BarChart3, Gauge,
  Users, Settings, LogOut, Wrench, Shield,
  Sun, Moon, Grid2X2, Brain,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';

const navMain = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/visits', icon: ClipboardList, label: 'Visits' },
  { to: '/vehicles', icon: Car, label: 'Vehicles' },
  { to: '/fleet-intelligence', icon: Brain, label: 'Fleet intelligence' },
  { to: '/services', icon: Wrench, label: 'Services' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/visionflow', icon: Gauge, label: 'ANPR & speed' },
  { to: '/visionflow/multicam', icon: Grid2X2, label: 'Camera wall' },
];

const navAdmin: {
  to: string;
  icon: typeof Users;
  label: string;
  roles: readonly ('admin' | 'manager')[];
}[] = [
  { to: '/users', icon: Users, label: 'Users', roles: ['admin', 'manager'] },
  { to: '/audit', icon: Shield, label: 'Audit Log', roles: ['admin', 'manager'] },
  { to: '/settings', icon: Settings, label: 'Settings', roles: ['admin'] },
];

export const Sidebar: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggle, isDark } = useTheme();
  const isAdmin = ['admin', 'manager'].includes(user?.role || '');

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(37,99,235,0.35)',
            flexShrink: 0,
          }}>
            <Car size={18} color="white" />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
              CarTrack Pro
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>
              AI Monitoring System
            </div>
          </div>
        </div>

        {/* Live indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14 }}>
          <div style={{ position: 'relative', width: 8, height: 8 }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: '#10b981', animation: 'pingAnim 1.5s ease-in-out infinite', opacity: 0.6,
            }} />
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
          </div>
          <span style={{ fontSize: 11, color: '#10b981', fontWeight: 500 }}>System Live</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        <div className="nav-section-label">Main</div>
        {navMain.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}

        {isAdmin && (
          <>
            <div className="nav-section-label" style={{ marginTop: 8 }}>Admin</div>
            {navAdmin
              .filter(item => user?.role && (item.roles as readonly string[]).includes(user.role))
              .map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon size={16} />
                <span>{label}</span>
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        {/* Theme Toggle */}
        <button
          onClick={toggle}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '9px 12px', borderRadius: 8, marginBottom: 8,
            background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
            border: `1px solid var(--border-light)`,
            cursor: 'pointer', transition: 'all 0.2s',
            color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
        >
          {isDark
            ? <><Sun size={14} color="var(--text-warning)" /><span>Light Mode</span></>
            : <><Moon size={14} color="#818cf8" /><span>Dark Mode</span></>}
          {/* Toggle pill */}
          <div style={{ marginLeft: 'auto', width: 34, height: 18, borderRadius: 99, background: isDark ? '#374151' : '#2563eb', position: 'relative', transition: 'background 0.3s' }}>
            <div style={{
              position: 'absolute', top: 2, left: isDark ? 2 : 18,
              width: 14, height: 14, borderRadius: '50%', background: 'white',
              transition: 'left 0.3s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }} />
          </div>
        </button>

        {/* User Card */}
        <div className="user-card" onClick={() => { logout(); navigate('/login'); }}>
          <div className="user-avatar">{user?.full_name?.[0]?.toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.full_name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
              {user?.role}
            </div>
          </div>
          <LogOut size={14} color="var(--text-muted)" />
        </div>
      </div>

      <style>{`
        @keyframes pingAnim {
          75%, 100% { transform: scale(2.5); opacity: 0; }
        }
      `}</style>
    </aside>
  );
};
