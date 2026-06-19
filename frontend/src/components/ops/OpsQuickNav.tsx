import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ClipboardList, Car, Brain, Wrench, BarChart3, Plus,
} from 'lucide-react';

const LINKS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/visits', label: 'Visits', icon: ClipboardList },
  { to: '/vehicles', label: 'Vehicles', icon: Car },
  { to: '/fleet-intelligence', label: 'Fleet intel', icon: Brain },
  { to: '/services', label: 'Services', icon: Wrench },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
] as const;

interface Props {
  primaryAction?: { to: string; label: string };
}

export const OpsQuickNav: React.FC<Props> = ({ primaryAction }) => {
  const { pathname } = useLocation();

  return (
    <nav className="ops-quick-nav" aria-label="Operational sections">
      {LINKS.map(link => {
        const Icon = link.icon;
        const base = link.to.split('?')[0];
        const active = 'end' in link && link.end
          ? pathname === link.to
          : pathname === base || pathname.startsWith(`${base}/`);
        return (
          <Link
            key={link.to}
            to={link.to}
            className={`ops-quick-nav-link${active ? ' active' : ''}`}
          >
            <Icon size={14} />
            {link.label}
          </Link>
        );
      })}
      {primaryAction && (
        <Link to={primaryAction.to} className="ops-quick-nav-cta">
          <Plus size={14} /> {primaryAction.label}
        </Link>
      )}
    </nav>
  );
};
