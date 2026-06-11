import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Car, Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Toaster } from 'react-hot-toast';
import { GlobalSearch } from '../GlobalSearch';
import { ClientErrorBoundary } from '../ClientErrorBoundary';
import { settingsApi } from '../../services/api';
import { VERCEL_MISSING_API } from '../../services/apiConfig';
import { syncClientTimeFromPublicSettings } from '../../lib/qatarTime';
import { useCompactLayout } from '../../hooks/useCompactLayout';

export const Layout: React.FC = () => {
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  useCompactLayout();

  useEffect(() => {
    settingsApi
      .public()
      .then(res => {
        window.__CARTRACK_REPORT_ERRORS__ = res.data.client_error_auto_capture !== false;
        syncClientTimeFromPublicSettings(res.data);
      })
      .catch(() => {
        window.__CARTRACK_REPORT_ERRORS__ = true;
      });
  }, []);

  // Close the mobile drawer whenever the route changes
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  // Lock body scroll + Escape to close drawer on mobile
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [navOpen]);

  return (
  <div className="app-layout">
    {VERCEL_MISSING_API && (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        background: '#b45309', color: '#fff', padding: '10px 16px', fontSize: 13,
        textAlign: 'center', lineHeight: 1.45,
      }}>
        Vercel UI only: set <strong>VITE_API_URL</strong> to your HTTPS FastAPI backend in Vercel → Settings → Environment Variables, then redeploy.
        See docs/VERCEL.md in the repo.
      </div>
    )}
    {navOpen && (
      <div
        className="sidebar-overlay"
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />
    )}
    <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
    <main className="app-main">
      <header className="desktop-topbar">
        <GlobalSearch />
      </header>
      <header className="mobile-topbar">
        <button
          type="button"
          className="nav-toggle nav-toggle--open"
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          aria-expanded={navOpen}
        >
          <Menu size={22} strokeWidth={2.25} />
        </button>
        <div className="mobile-topbar-brand">
          <div className="mobile-topbar-logo">
            <Car size={16} color="white" />
          </div>
          <span className="mobile-topbar-title">CarTrack Pro</span>
        </div>
        <div className="mobile-topbar-search">
          <GlobalSearch />
        </div>
      </header>
      <div className="page-container animate-fade-in">
        <ClientErrorBoundary key={location.pathname + location.search}>
          <Outlet />
        </ClientErrorBoundary>
      </div>
    </main>
    <Toaster
      position="top-right"
      gutter={8}
      toastOptions={{
        duration: 3500,
        style: {
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          fontSize: '13px',
          fontFamily: 'Inter, sans-serif',
          boxShadow: 'var(--shadow-elevated)',
        },
        success: { iconTheme: { primary: 'var(--emerald)', secondary: '#fff' } },
        error:   { iconTheme: { primary: 'var(--red)', secondary: '#fff' } },
      }}
    />
  </div>
  );
};
