import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { Layout } from './components/layout/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { VisitsList } from './pages/visits/VisitsList';
import { NewVisit } from './pages/visits/NewVisit';
import { VisitDetail } from './pages/visits/VisitDetail';
import { Vehicles } from './pages/vehicles/Vehicles';
import { VehicleProfile } from './pages/vehicles/VehicleProfile';
import { FleetIntelligence } from './pages/fleet/FleetIntelligence';
import { Analytics } from './pages/analytics/Analytics';
import { VisionFlowStudio } from './pages/visionflow/VisionFlowStudio';
import { VisionFlowMultiCam } from './pages/visionflow/VisionFlowMultiCam';
import { VisionFlowHistory } from './pages/visionflow/VisionFlowHistory';
import { Users } from './pages/users/Users';
import { Services } from './pages/Services';
import { Audit } from './pages/Audit';
import { Settings } from './pages/settings/Settings';
import { ClientErrorBoundary } from './components/ClientErrorBoundary';
import { getHomeRoute } from './lib/permissions';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403) return false;
        if (status != null && status >= 500) return failureCount < 3;
        return failureCount < 1;
      },
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

const LoginRedirect: React.FC = () => {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return <Login />;
  return <Navigate to={getHomeRoute(user)} replace />;
};

/** Exported for route-guard / auth tests (MemoryRouter harness). */
export const AppRoutes: React.FC = () => (
  <Routes>
    <Route path="/login" element={<LoginRedirect />} />
    <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
      <Route path="/" element={<ProtectedRoute pageKey="dashboard"><Dashboard /></ProtectedRoute>} />
      <Route path="/visits" element={<ProtectedRoute pageKey="visits"><VisitsList /></ProtectedRoute>} />
      <Route path="/visits/new" element={<ProtectedRoute pageKey="visits"><NewVisit /></ProtectedRoute>} />
      <Route path="/visits/:id" element={<ProtectedRoute pageKey="visits"><VisitDetail /></ProtectedRoute>} />
      <Route path="/vehicles" element={<ProtectedRoute pageKey="vehicles"><Vehicles /></ProtectedRoute>} />
      <Route path="/vehicles/:id" element={<ProtectedRoute pageKey="vehicles"><VehicleProfile /></ProtectedRoute>} />
      <Route path="/fleet-intelligence" element={<ProtectedRoute pageKey="fleet"><FleetIntelligence /></ProtectedRoute>} />
      <Route path="/services" element={<ProtectedRoute pageKey="services"><Services /></ProtectedRoute>} />
      <Route path="/analytics" element={<ProtectedRoute pageKey="analytics"><Analytics /></ProtectedRoute>} />
      <Route path="/visionflow" element={<ProtectedRoute pageKey="visionflow"><VisionFlowStudio /></ProtectedRoute>} />
      <Route path="/visionflow/multicam" element={<ProtectedRoute pageKey="visionflow_multicam"><VisionFlowMultiCam /></ProtectedRoute>} />
      <Route path="/visionflow/history" element={<ProtectedRoute pageKey="visionflow"><VisionFlowHistory /></ProtectedRoute>} />
      <Route path="/cameras" element={<Navigate to="/visionflow/multicam" replace />} />
      <Route path="/users" element={<ProtectedRoute adminOnly pageKey="users"><Users /></ProtectedRoute>} />
      <Route path="/audit" element={<ProtectedRoute adminOnly pageKey="audit"><Audit /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute adminRoleOnly pageKey="settings"><Settings /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>
);

export default function App() {
  return (
    <ClientErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ClientErrorBoundary>
  );
}
