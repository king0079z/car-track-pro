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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, retry: 1 },
  },
});

/** Exported for route-guard / auth tests (MemoryRouter harness). */
export const AppRoutes: React.FC = () => {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/visits" element={<VisitsList />} />
        <Route path="/visits/new" element={<NewVisit />} />
        <Route path="/visits/:id" element={<VisitDetail />} />
        <Route path="/vehicles" element={<Vehicles />} />
        <Route path="/vehicles/:id" element={<VehicleProfile />} />
        <Route path="/fleet-intelligence" element={<FleetIntelligence />} />
        <Route path="/services" element={<Services />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/visionflow" element={<VisionFlowStudio />} />
        <Route path="/visionflow/multicam" element={<VisionFlowMultiCam />} />
        <Route path="/visionflow/history" element={<VisionFlowHistory />} />
        <Route path="/cameras" element={<Navigate to="/visionflow/multicam" replace />} />
        <Route path="/users" element={<ProtectedRoute adminOnly><Users /></ProtectedRoute>} />
        <Route path="/audit" element={<ProtectedRoute adminOnly><Audit /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute adminRoleOnly><Settings /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
};

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
