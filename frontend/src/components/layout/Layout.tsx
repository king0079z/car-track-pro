import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Toaster } from 'react-hot-toast';
import { GlobalSearch } from '../GlobalSearch';
import { ClientErrorBoundary } from '../ClientErrorBoundary';
import { settingsApi } from '../../services/api';
import { VERCEL_MISSING_API } from '../../services/apiConfig';
import { syncClientTimeFromPublicSettings } from '../../lib/qatarTime';

export const Layout: React.FC = () => {
  const location = useLocation();

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
    <Sidebar />
    <main className="app-main">
      {/* Top bar with global search */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'var(--topbar-bg)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border-light)',
        padding: '10px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      }}>
        <GlobalSearch />
      </div>
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
