import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { canAccessPage, canAccessRoute, getHomeRoute, type PageKey } from '../lib/permissions';

export const PageLoader: React.FC = () => (
  <div style={{
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-base)',
  }}>
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        border: '3px solid rgba(59,130,246,0.15)',
        borderTopColor: '#3b82f6',
        animation: 'spin 0.7s linear infinite',
      }} />
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading...</span>
    </div>
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

export const ProtectedRoute: React.FC<{
  children: React.ReactNode;
  adminOnly?: boolean;
  adminRoleOnly?: boolean;
  pageKey?: PageKey;
}> = ({ children, adminOnly, adminRoleOnly, pageKey }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <PageLoader />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (adminOnly && !['admin', 'manager'].includes(user?.role || '')) {
    return <Navigate to={getHomeRoute(user)} replace />;
  }
  if (adminRoleOnly && user?.role !== 'admin') {
    return <Navigate to={getHomeRoute(user)} replace />;
  }

  if (pageKey) {
    if (!canAccessPage(user, pageKey)) return <Navigate to={getHomeRoute(user)} replace />;
  } else if (!canAccessRoute(user, location.pathname)) {
    return <Navigate to={getHomeRoute(user)} replace />;
  }

  return <>{children}</>;
};
