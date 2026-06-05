import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
  /** Strict admin role (backend settings API is admin-only) */
  adminRoleOnly?: boolean;
}> = ({ children, adminOnly, adminRoleOnly }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  if (isLoading) return <PageLoader />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (adminOnly && !['admin', 'manager'].includes(user?.role || '')) {
    return <Navigate to="/" replace />;
  }
  if (adminRoleOnly && user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};
