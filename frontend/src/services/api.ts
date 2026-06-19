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
    const status = err.response?.status;
    if (status === 401) {
      localStorage.removeItem('cartrack_token');
      localStorage.removeItem('cartrack_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
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
  duplicates: () => api.get('/api/vehicles/duplicates'),
  merge: (targetId: number, sourceId: number) =>
    api.post(`/api/vehicles/${targetId}/merge`, { source_vehicle_id: sourceId }),
  correctPlate: (id: number, plate: string, mergeIfExists = false) =>
    api.patch(`/api/vehicles/${id}/plate`, { plate_number: plate, merge_if_exists: mergeIfExists }),
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
  resendWhatsapp: (id: number) => api.post(`/api/visits/${id}/whatsapp/resend`),
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
  todayOps: () => api.get('/api/analytics/today-ops'),
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

  /** Plates grouped with shop duration totals and segment history (dashboard). */
  summary: (limitPlates = 50, lookbackDays = 7) =>
    api.get('/api/anpr/summary', { params: { limit_plates: limitPlates, lookback_days: lookbackDays } }),

  /** All detections + vehicle info for a specific plate. */
  plate: (plate: string) => api.get(`/api/anpr/plate/${encodeURIComponent(plate)}`),

  detection: (id: number) => api.get(`/api/anpr/detections/${id}`),
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

  /** Multi-camera grid wall (up to LIVE_MAX_CAMERAS feeds). */
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
  roster: () => api.get('/api/users/roster'),
  pagePermissionsMeta: () => api.get('/api/users/page-permissions-meta'),
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
      whatsapp_ready?: boolean;
      whatsapp_dry_run?: boolean;
    }>('/api/settings/public'),
  backupNow: () => api.post<{ ok: boolean; path?: string; files?: number; bytes?: number }>('/api/settings/backup-now'),
  backups: () =>
    api.get<{
      enabled: boolean;
      interval_hours: number;
      retention_days: number;
      backup_dir: string;
      last_run: Record<string, unknown>;
      backups: Array<{ name: string; created_at?: string; bytes?: number; files?: number }>;
    }>('/api/settings/backups'),
  whatsappStatus: () =>
    api.get<{
      configured: boolean;
      enabled_env: boolean;
      runtime_toggle: boolean;
      uses_template: boolean;
      default_country_code: string;
    }>('/api/settings/whatsapp-status'),
  ocrTraining: () =>
    api.get<{
      dataset_dir: string;
      labels_csv: boolean;
      total_crops?: number;
      labeled_crops?: number;
      unlabeled_crops?: number;
      crop_files?: number;
      harvest_script: string;
      evaluate_script: string;
      doc_path: string;
    }>('/api/settings/ocr-training'),
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
  connection_mode?: 'lan' | 'p2p' | 'auto' | 'cartrack_cloud' | 'cartrack_relay' | 'cloud_hls';
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
  connection_mode?: 'lan' | 'p2p' | 'auto' | 'cartrack_cloud' | 'cartrack_relay' | 'cloud_hls';
  cartrack_relay?: {
    publish_url?: string | null;
    view_url?: string | null;
    relay?: Record<string, unknown>;
  };
  cloud?: {
    online?: boolean | null;
    randsalt?: boolean | null;
    deps_ok?: boolean;
    tunnel?: Record<string, unknown>;
  };
  /** True when DAHUA_* env vars override cameras.json (cloud VPS deploy). */
  env_configured?: boolean;
};

export type CameraType = 'rtsp' | 'dahua_p2p';

export type RegistryCamera = {
  id: string;
  name: string;
  type: CameraType;
  enabled: boolean;
  slot_index: number;
  connection_mode: 'lan' | 'auto' | 'p2p' | 'cloud_hls';
  device_serial: string;
  device_type: string;
  security_code: string;
  p2p_local_port: number;
  host: string;
  rtsp_port: number;
  http_port: number;
  username: string;
  password: string;
  stream: 'main' | 'sub';
  use_tcp_transport: boolean;
  rtsp_url: string;
  meter_per_pixel: number;
  has_password: boolean;
  source: string;
  session_id: string;
  live?: { registered: boolean; enabled: boolean; job_id: string | null; slot_index: number | null };
  tunnel?: Record<string, unknown> | null;
};

export type CameraInput = Partial<
  Pick<
    RegistryCamera,
    | 'name' | 'type' | 'enabled' | 'connection_mode' | 'device_serial' | 'device_type'
    | 'security_code' | 'host' | 'rtsp_port' | 'http_port' | 'username' | 'password'
    | 'stream' | 'use_tcp_transport' | 'rtsp_url' | 'slot_index' | 'meter_per_pixel'
  >
> & {
  openapi_app_id?: string;
  openapi_app_secret?: string;
  openapi_base_url?: string;
  openapi_channel?: string;
  openapi_prefer_hd?: boolean;
};

export type WifiNetwork = {
  ssid: string;
  bssid?: string;
  intensity?: number;
  encrypt?: number | string | null;
};

export type ImouUsageStats = {
  app_id?: string | null;
  blocked_sec?: number;
  blocked?: boolean;
  calls_since_start?: number;
  top_methods?: Array<{ method: string; count: number }>;
  free_tier_hint?: string;
  recovery?: string;
};

export type CameraProvisionResult = {
  ok: boolean;
  error?: string;
  session_id?: string;
  job_id?: string;
  source?: string;
  slot_index?: number;
  stopped?: boolean;
};

export const camerasApi = {
  profiles: () => api.get('/api/cameras/profiles'),

  // ── Multi-camera registry (Dahua cloud + generic RTSP/NVR) ──
  list: () => api.get<{ cameras: RegistryCamera[]; count: number }>('/api/cameras'),
  create: (data: CameraInput, connect = true) =>
    api.post<{
      camera: RegistryCamera;
      provision?: CameraProvisionResult;
      bind?: { ok: boolean; error?: string; mine?: boolean; just_bound?: boolean };
    }>('/api/cameras', data, { params: { connect }, timeout: 45000 }),
  get: (id: string) => api.get<RegistryCamera>(`/api/cameras/${encodeURIComponent(id)}`),
  update: (id: string, data: CameraInput, reconnect = true) =>
    api.patch<{ camera: RegistryCamera; provision?: CameraProvisionResult }>(
      `/api/cameras/${encodeURIComponent(id)}`,
      data,
      { params: { reconnect }, timeout: 30000 },
    ),
  remove: (id: string) =>
    api.delete<{ ok: boolean; deleted: string }>(`/api/cameras/${encodeURIComponent(id)}`),
  connect: (id: string) =>
    api.post<CameraProvisionResult>(`/api/cameras/${encodeURIComponent(id)}/connect`, {}, { timeout: 30000 }),
  disconnect: (id: string) =>
    api.post<{ ok: boolean; stopped: string }>(`/api/cameras/${encodeURIComponent(id)}/disconnect`),
  status: (id: string) =>
    api.get<{ id: string; live: RegistryCamera['live']; tunnel: Record<string, unknown> | null }>(
      `/api/cameras/${encodeURIComponent(id)}/status`,
    ),
  test: (id: string) =>
    api.post<{ ok: boolean; error?: string; width?: number; height?: number; fps?: number }>(
      `/api/cameras/${encodeURIComponent(id)}/test`,
      {},
      { timeout: 30000 },
    ),
  ptz: (id: string, direction: string, duration = 1) =>
    api.post<{ ok: boolean; error?: string; code?: string }>(
      `/api/cameras/${encodeURIComponent(id)}/ptz`,
      { direction, duration },
      { timeout: 10000 },
    ),
  wifiCurrent: (id: string) =>
    api.get<{ ok: boolean; error?: string; ssid?: string | null; linkEnable?: boolean; intensity?: number }>(
      `/api/cameras/${encodeURIComponent(id)}/wifi`,
      { timeout: 35000 },
    ),
  wifiScan: (id: string) =>
    api.post<{ ok: boolean; error?: string; networks?: WifiNetwork[]; cached?: boolean; retry_after_sec?: number }>(
      `/api/cameras/${encodeURIComponent(id)}/wifi/scan`,
      {},
      { timeout: 50000 },
    ),
  wifiSet: (id: string, body: { ssid: string; bssid?: string; password?: string }) =>
    api.post<{ ok: boolean; error?: string; ssid?: string; code?: string }>(
      `/api/cameras/${encodeURIComponent(id)}/wifi`,
      body,
      { timeout: 120000 },
    ),

  getHeroA1: () => api.get<DahuaHeroA1Public>('/api/cameras/dahua/hero-a1', { timeout: 8000 }),
  getHeroCloudStatus: () =>
    api.get<{ online?: boolean | null; randsalt?: boolean | null; tunnel?: Record<string, unknown> }>(
      '/api/cameras/dahua/hero-a1/cloud-status',
      { timeout: 8000 },
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
      { timeout: 120_000 },
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
  cloudTunnelStart: (data?: { username?: string; password?: string }) =>
    api.post('/api/cameras/dahua/hero-a1/cloud-tunnel/start', data ?? {}, { timeout: 90000 }),
  cloudTunnelStatus: () =>
    api.get<{ mode: string; configured: boolean; tunnel: Record<string, unknown> }>(
      '/api/cameras/dahua/hero-a1/cloud-tunnel/status',
    ),
  imouBindStatus: () =>
    api.get<{ ok: boolean; serial?: string; bound?: { isBind?: boolean; isMine?: boolean }; error?: string; code?: string; usage?: ImouUsageStats }>(
      '/api/cameras/dahua/hero-a1/imou/status',
      { timeout: 15000 },
    ),
  imouUsage: () =>
    api.get<ImouUsageStats>('/api/cameras/dahua/hero-a1/imou/usage', { timeout: 8000 }),
  imouBindHeroA1: (data?: { password?: string }) =>
    api.post<{ ok: boolean; bind: Record<string, unknown>; connection_mode: string }>(
      '/api/cameras/dahua/hero-a1/imou/bind',
      data ?? {},
      { timeout: 60000 },
    ),
  localSetupDiscover: () =>
    api.get<{
      ok: boolean;
      cameras: Array<{ host: string; serial?: string }>;
      requires_shop_network?: boolean;
      remote_server?: boolean;
      hint?: string;
    }>('/api/cameras/dahua/hero-a1/local-setup/discover', { timeout: 12000 }),
  localSetupWifiScan: (data: { host: string; password?: string; username?: string }) =>
    api.post<{ ok: boolean; networks?: Array<{ ssid: string; bssid: string; intensity: number }>; error?: string }>(
      '/api/cameras/dahua/hero-a1/local-setup/wifi-scan',
      data,
      { timeout: 20000 },
    ),
  localSetupWifiConnect: (data: {
    host: string;
    ssid: string;
    wifi_password?: string;
    device_password?: string;
  }) =>
    api.post<{ ok: boolean; message?: string; error?: string }>(
      '/api/cameras/dahua/hero-a1/local-setup/wifi-connect',
      data,
      { timeout: 30000 },
    ),
  diagnoseHeroA1: () =>
    api.get<{
      pc_ips: string[];
      camera_host: string;
      remote_server?: boolean;
      subnet_mismatch: boolean;
      lan_rtsp_reachable: boolean;
      cloud_tunnel_running: boolean;
      fixes: string[];
    }>('/api/cameras/dahua/hero-a1/diagnose', { timeout: 8000 }),
  cartrackRelayStart: () => api.post('/api/cameras/dahua/hero-a1/cartrack-relay/start'),
  cartrackRelayStop: () => api.post('/api/cameras/dahua/hero-a1/cartrack-relay/stop'),
  cartrackRelayStatus: () =>
    api.get<{ connection_mode: string; publish_url?: string; view_url?: string; relay: Record<string, unknown> }>(
      '/api/cameras/dahua/hero-a1/cartrack-relay/status',
    ),
};

export { WS_URL } from './apiConfig';
