import axios from 'axios';
import { API_BASE_URL } from './apiConfig';
import { installAxiosErrorReporting } from './clientErrorReporter';

export { API_BASE_URL } from './apiConfig';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('cartrack_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('cartrack_token');
      localStorage.removeItem('cartrack_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

installAxiosErrorReporting(api);

// ── Auth ──────────────────────────────────────────────────────────────
export const authApi = {
  login: (username: string, password: string) =>
    api.post('/api/auth/login', { username, password }),
  me: () => api.get('/api/auth/me'),
  register: (data: any) => api.post('/api/auth/register', data),
};

// ── Vehicles ──────────────────────────────────────────────────────────
export const vehiclesApi = {
  list: (params?: { search?: string; skip?: number; limit?: number }) =>
    api.get('/api/vehicles', { params }),
  get: (id: number) => api.get(`/api/vehicles/${id}`),
  history: (id: number) => api.get(`/api/vehicles/${id}/history`),
  lookup: (plate: string) => api.get(`/api/vehicles/lookup/${plate}`),
  create: (data: any) => api.post('/api/vehicles', data),
  update: (id: number, data: any) => api.patch(`/api/vehicles/${id}`, data),
  delete: (id: number) => api.delete(`/api/vehicles/${id}`),
};

// ── Visits ────────────────────────────────────────────────────────────
export const visitsApi = {
  list: (params?: any) => api.get('/api/visits', { params }),
  active: () => api.get('/api/visits/active'),
  inShop: () => api.get('/api/visits/in-shop'),
  get: (id: number) => api.get(`/api/visits/${id}`),
  create: (data: any) => api.post('/api/visits', data),
  update: (id: number, data: any) => api.patch(`/api/visits/${id}`, data),
  checkout: (id: number) => api.post(`/api/visits/${id}/checkout`),
  captureSignature: (id: number, signature: string) =>
    api.post(`/api/visits/${id}/signature`, { signature }),
  addServiceItem: (visitId: number, data: { service_id: number; price?: number; assigned_staff_id?: number; notes?: string }) =>
    api.post(`/api/visits/${visitId}/services`, data),
  updateServiceItem: (visitId: number, itemId: number, data: any) =>
    api.patch(`/api/visits/${visitId}/services/${itemId}`, data),
  delete: (id: number) => api.delete(`/api/visits/${id}`),
};

// ── Services ──────────────────────────────────────────────────────────
export const servicesApi = {
  list: () => api.get('/api/services'),
  get: (id: number) => api.get(`/api/services/${id}`),
  create: (data: any) => api.post('/api/services', data),
  update: (id: number, data: any) => api.patch(`/api/services/${id}`, data),
  delete: (id: number) => api.delete(`/api/services/${id}`),
};

// ── Analytics ─────────────────────────────────────────────────────────
export const analyticsApi = {
  dashboard: () => api.get('/api/analytics/dashboard'),
  report: (params?: { start_date?: string; end_date?: string }) =>
    api.get('/api/analytics/report', { params }),
  hourly: (date?: string) =>
    api.get('/api/analytics/hourly', { params: date ? { target_date: date } : {} }),
  summary: (params?: { days?: number }) => api.get('/api/analytics/summary', { params }),
  daily: (params?: { days?: number }) => api.get('/api/analytics/daily', { params }),
  byService: (params?: { days?: number }) => api.get('/api/analytics/by-service', { params }),
  serviceDuration: (params?: { days?: number }) =>
    api.get('/api/analytics/service-duration', { params }),
  serviceDurationByVehicleType: (params?: { days?: number; vehicle_types?: string }) =>
    api.get('/api/analytics/service-duration-by-vehicle-type', { params }),
  serviceDurationJobs: (params: { service_name: string; days?: number; vehicle_types?: string }) =>
    api.get('/api/analytics/service-duration-jobs', { params }),
  byVehicleType: (params?: { days?: number }) =>
    api.get('/api/analytics/by-vehicle-type', { params }),
  byVehicleModel: (params?: { days?: number }) =>
    api.get('/api/analytics/by-vehicle-model', { params }),
  staffKpi: (params?: { days?: number }) => api.get('/api/analytics/staff-kpi', { params }),
  seasonal: (params?: { year?: number }) => api.get('/api/analytics/seasonal', { params }),
};

// ── ANPR integration (plate ↔ CarTrack DB) ───────────────────────────
export const anprApi = {
  /** Bulk-sync detected plates from a completed VisionFlow job into CarTrack DB. */
  sync: (
    jobId: string,
    videoName: string,
    detections: {
      plate: string;
      speed_kmh?: number | null;
      track_id?: number | null;
      t_enter_sec?: number | null;
      t_exit_sec?: number | null;
      duration_sec?: number | null;
    }[],
  ) => api.post('/api/anpr/sync', { job_id: jobId, video_name: videoName, detections }),

  /** Recent ANPR detections with linked vehicle / visit info. */
  recent: (limit = 30) => api.get('/api/anpr/recent', { params: { limit } }),

  /** All detections + vehicle info for a specific plate. */
  plate: (plate: string) => api.get(`/api/anpr/plate/${encodeURIComponent(plate)}`),

  /** Dashboard stats (today count, unique plates, avg speed, linked ratio). */
  stats: () => api.get('/api/anpr/stats'),

  /** Detections for all plates in a given VisionFlow job_id. */
  byJob: (jobId: string) => api.get('/api/anpr/recent', { params: { limit: 200, job_id: jobId } }),

  /** Create a Vehicle + Visit from an ANPR detection row. */
  createVisit: (detectionId: number, data: {
    vehicle_type?: string; make?: string; model?: string;
    color?: string; owner_name?: string; owner_phone?: string;
    notes?: string; assigned_bay?: number;
  }) => api.post(`/api/anpr/${detectionId}/visit`, data),
};

// ── VisionFlow (ANPR & speed analysis) ───────────────────────────────
export const visionflowSyncApi = {
  /** Manually re-sync a completed job's plates to CarTrack DB. */
  syncJob: (jobId: string) => api.post(`/vf/api/jobs/${encodeURIComponent(jobId)}/sync`),
  /** Retroactive bulk sync of all history jobs. */
  syncHistory: (limit = 100) => api.post('/vf/api/sync-history', null, { params: { limit } }),
};

export const visionflowApi = {
  /** Upload a video and start analysis. Returns { job_id }. */
  analyze: (formData: FormData) =>
    fetch('/vf/api/analyze', { method: 'POST', body: formData }),

  /** Start live analysis from server-side camera index or RTSP/HTTP URL. */
  liveStart: (formData: FormData) =>
    fetch('/vf/api/live/start', { method: 'POST', body: formData }),

  /** Request graceful stop of a live session. */
  liveStop: (jobId: string) =>
    fetch(`/vf/api/live/stop/${encodeURIComponent(jobId)}`, { method: 'POST' }),

  liveSessions: () => fetch('/vf/api/live/sessions'),

  liveHealth: () => fetch('/vf/api/live/health'),

  localCameras: () => fetch('/vf/api/live/cameras'),

  /** Multi-camera grid wall (up to 4 feeds). */
  liveGrid: () => fetch('/vf/api/live/grid'),

  gridStart: (slot: number, source: string, record = true, alwaysOn = true) => {
    const fd = new FormData();
    fd.append('source', source);
    fd.append('record', record ? 'true' : 'false');
    fd.append('always_on', alwaysOn ? 'true' : 'false');
    return fetch(`/vf/api/live/grid/${slot}/start`, { method: 'POST', body: fd });
  },

  gridStop: (slot: number) =>
    fetch(`/vf/api/live/grid/${slot}/stop`, { method: 'POST' }),

  gridStopAll: () => fetch('/vf/api/live/grid/stop-all', { method: 'POST' }),

  /** Poll job status, progress, and live vehicle manifest. */
  jobStatus: (jobId: string) => fetch(`/vf/api/jobs/${encodeURIComponent(jobId)}`),

  /** Live JPEG snapshot URL (poll with cache-buster; 204 until first frame is ready). */
  snapshotUrl: (jobId: string) =>
    `/vf/api/jobs/${encodeURIComponent(jobId)}/snapshot.jpg`,

  /** Download annotated video URL. */
  videoUrl: (jobId: string) =>
    `/vf/api/jobs/${encodeURIComponent(jobId)}/video`,

  /** Analysis history list. */
  history: (limit = 100) => fetch(`/vf/api/history?limit=${limit}`),

  /** API / model health check. */
  status: () => api.get('/vf/api/status'),
};

// ── Users ─────────────────────────────────────────────────────────────
export const usersApi = {
  list: () => api.get('/api/users'),
  get: (id: number) => api.get(`/api/users/${id}`),
  create: (data: any) => api.post('/api/users', data),
  update: (id: number, data: any) => api.patch(`/api/users/${id}`, data),
  delete: (id: number) => api.delete(`/api/users/${id}`),
};

// ── Audit ─────────────────────────────────────────────────────────────
export const auditApi = {
  list: (params?: {
    page?: number;
    limit?: number;
    action?: string;
    /** Comma-separated; OR match (e.g. client_auto_error,system_error_report) */
    actions?: string;
    entity_type?: string;
  }) => api.get('/api/audit', { params }),
  reportIncident: (data: { summary: string; details: string; page_path?: string }) =>
    api.post('/api/audit/incident', data),
  snapshot: () => api.post('/api/audit/snapshot'),
  report: (params: { format?: 'csv' | 'json'; days?: number }) =>
    api.get('/api/audit/report', {
      params: { format: params.format ?? 'csv', days: params.days ?? 30 },
      responseType: 'blob',
    }),
};

// ── Settings ──────────────────────────────────────────────────────────
export const settingsApi = {
  get: () => api.get('/api/settings'),
  update: (data: Record<string, unknown>) => api.patch('/api/settings', data),
  reset: () => api.post('/api/settings/reset'),
  /** No auth — branding + maintenance banner + client error capture flag */
  public: () =>
    api.get<{
      business_name: string;
      maintenance_message: string;
      client_error_auto_capture: boolean;
      timezone: string;
    }>('/api/settings/public'),
};

// ── Application errors (Settings › Error log) ─────────────────────────
export const errorsApi = {
  stats: (days = 7) => api.get('/api/errors/stats', { params: { days } }),
  list: (params?: {
    page?: number;
    limit?: number;
    category?: string;
    categories?: string;
    severity?: string;
    resolved?: boolean;
    job_id?: string;
    plate?: string;
    search?: string;
    days?: number;
  }) => api.get('/api/errors', { params }),
  resolve: (id: number, resolved: boolean) => api.patch(`/api/errors/${id}`, { resolved }),
  export: (params: { format?: 'csv' | 'json'; days?: number; categories?: string; unresolvedOnly?: boolean }) =>
    api.get('/api/errors/export', {
      params: {
        format: params.format ?? 'csv',
        days: params.days ?? 30,
        categories: params.categories,
        unresolved_only: params.unresolvedOnly ?? false,
      },
      responseType: 'blob',
    }),
  recordTest: () => api.post('/api/errors/record-test'),
};

// ── IP cameras (Dahua Hero A1) ────────────────────────────────────────
export type DahuaHeroA1Config = {
  enabled: boolean;
  host: string;
  rtsp_port: number;
  http_port: number;
  username: string;
  password: string;
  stream: 'main' | 'sub';
  label: string;
  use_tcp_transport: boolean;
  connection_mode?: 'lan' | 'p2p' | 'auto' | 'cartrack_relay';
  p2p_local_port?: number;
  device_serial?: string;
  device_type?: string;
  security_code?: string;
  cartrack_relay_publish_url?: string;
  cartrack_relay_view_url?: string;
};

export type DahuaQrParseResult = {
  parsed: { serial_number: string; device_type: string; security_code: string };
  suggested_config: Partial<DahuaHeroA1Config>;
  dmss_steps: string[];
  cartrack_steps: string[];
  important: string;
  saved?: boolean;
  public?: DahuaHeroA1Public;
};

export type DahuaHeroA1Public = {
  profile: {
    id: string;
    model: string;
    name: string;
    usb_note: string;
    default_source_token: string;
  };
  config: DahuaHeroA1Config;
  configured: boolean;
  rtsp_url_masked: string;
  source_token: string;
  connection_mode?: 'lan' | 'p2p' | 'auto' | 'cartrack_relay';
  cartrack_relay?: {
    publish_url?: string | null;
    view_url?: string | null;
    relay?: Record<string, unknown>;
  };
  cloud?: {
    online?: boolean;
    randsalt?: boolean;
    deps_ok?: boolean;
    tunnel?: Record<string, unknown>;
  };
};

export const camerasApi = {
  profiles: () => api.get('/api/cameras/profiles'),
  getHeroA1: () => api.get<DahuaHeroA1Public>('/api/cameras/dahua/hero-a1', { timeout: 15000 }),
  getHeroCloudStatus: () =>
    api.get<{ online?: boolean | null; randsalt?: boolean | null; tunnel?: Record<string, unknown> }>(
      '/api/cameras/dahua/hero-a1/cloud-status',
      { timeout: 25000 },
    ),
  getHeroLiveSource: () =>
    api.get<{ token: string | null; configured: boolean; rtsp_resolves: boolean }>(
      '/api/cameras/dahua/hero-a1/live-source',
    ),
  updateHeroA1: (data: Partial<DahuaHeroA1Config>) =>
    api.patch<DahuaHeroA1Public>('/api/cameras/dahua/hero-a1', data),
  testHeroA1: (data?: Partial<DahuaHeroA1Config & { use_tcp_transport?: boolean }>) =>
    api.post<{ ok: boolean; error?: string; width?: number; height?: number; fps?: number }>(
      '/api/cameras/dahua/hero-a1/test',
      data ?? {},
    ),
  discoverHeroA1: () =>
    api.post<{
      candidates: Array<{ host: string; confidence: string; likely_model: string }>;
      hint: string;
      scanned_subnets?: string[];
      local_ips?: string[];
      hosts_checked?: number;
    }>('/api/cameras/dahua/hero-a1/discover', {}, { timeout: 90000 }),
  ptzHeroA1: (direction: string, duration = 1) =>
    api.post('/api/cameras/dahua/hero-a1/ptz', { direction, duration }),
  statusHeroA1: () => api.get('/api/cameras/dahua/hero-a1/status'),
  parseHeroQr: (qr: string, save = true) =>
    api.post<DahuaQrParseResult>('/api/cameras/dahua/hero-a1/parse-qr', { qr, save }),
  p2pStart: (data?: { username?: string; password?: string }) =>
    api.post('/api/cameras/dahua/hero-a1/p2p/start', data ?? {}, { timeout: 20000 }),
  p2pStop: () => api.post('/api/cameras/dahua/hero-a1/p2p/stop'),
  p2pStatus: () => api.get<{ connection_mode: string; tunnel: Record<string, unknown> }>(
    '/api/cameras/dahua/hero-a1/p2p/status',
  ),
  cartrackRelayStart: () => api.post('/api/cameras/dahua/hero-a1/cartrack-relay/start'),
  cartrackRelayStop: () => api.post('/api/cameras/dahua/hero-a1/cartrack-relay/stop'),
  cartrackRelayStatus: () =>
    api.get<{ connection_mode: string; publish_url?: string; view_url?: string; relay: Record<string, unknown> }>(
      '/api/cameras/dahua/hero-a1/cartrack-relay/status',
    ),
};

export { WS_URL } from './apiConfig';
