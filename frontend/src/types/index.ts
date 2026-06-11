export type UserRole = 'admin' | 'manager' | 'staff' | 'viewer';

export interface User {
  id: number;
  full_name: string;
  email: string;
  username: string;
  role: UserRole;
  phone?: string;
  avatar_url?: string;
  is_active: boolean;
  last_login?: string;
  created_at: string;
  allowed_pages?: PageKey[];
  custom_page_permissions?: PageKey[] | null;
}

export type PageKey =
  | 'dashboard'
  | 'visits'
  | 'vehicles'
  | 'fleet'
  | 'services'
  | 'analytics'
  | 'visionflow'
  | 'visionflow_multicam'
  | 'users'
  | 'audit'
  | 'settings';

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}

export type VehicleStatus = 'in_shop' | 'completed' | 'waiting';

export interface Vehicle {
  id: number;
  plate_number: string;
  plate_country?: string;
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  vin?: string;
  vehicle_type?: string;
  owner_name?: string;
  owner_phone?: string;
  owner_email?: string;
  notes?: string;
  image_url?: string;
  total_visits: number;
  last_visit?: string;
  created_at: string;
}

export type ServiceCategory = 'wash' | 'detailing' | 'polish' | 'repair' | 'maintenance' | 'inspection' | 'other';

export interface Service {
  id: number;
  name: string;
  category: ServiceCategory;
  description?: string;
  base_price: number;
  estimated_duration_minutes: number;
  is_active: boolean;
  created_at: string;
  duration_job_count?: number;
  duration_source?: 'shop_signature' | 'measured' | 'category_default' | 'default';
  is_auto_calculated?: boolean;
}

export interface ServiceItem {
  id: number;
  visit_id: number;
  service_id: number;
  service: Service;
  price: number;
  notes?: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  actual_duration_minutes?: number | null;
  assigned_staff?: { id: number; full_name: string; username?: string };
  created_at: string;
}

export type VisitStatus = 'waiting' | 'in_service' | 'on_hold' | 'completed' | 'cancelled';
export type EntryMethod = 'auto_camera' | 'manual' | 'qr_code';

export interface InShopVehicle {
  plate_number: string;
  source: 'active_visit' | 'anpr_pending';
  visit_id?: number | null;
  work_order_number?: string | null;
  status?: VisitStatus | null;
  assigned_bay?: number | null;
  entry_time?: string | null;
  vehicle_id?: number | null;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  customer_name?: string | null;
  minutes_in_shop?: number | null;
  service_summary?: string | null;
  anpr_detection_ids?: number[] | null;
  suggested_bay?: number | null;
  camera_name?: string | null;
}

export interface Visit {
  id: number;
  visit_number: string;
  vehicle_id: number;
  vehicle: Vehicle;
  created_by_user?: { id: number; full_name: string; username?: string } | null;
  assigned_bay?: number;
  entry_time: string;
  exit_time?: string;
  duration_minutes?: number;
  anpr_camera_seconds?: number | null;
  anpr_camera_name?: string | null;
  status: VisitStatus;
  entry_method: EntryMethod;
  plate_image_url?: string;
  entry_camera_snapshot?: string;
  plate_confidence?: number;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  customer_signature?: string;
  supervisor_signature?: string;
  supervisor_signed_by_user?: { id: number; full_name: string; username: string };
  signature_captured_at?: string;
  total_price: number;
  payment_status: string;
  payment_method?: string;
  notes?: string;
  service_items: ServiceItem[];
  whatsapp_notified_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export type CameraLocation = string;
export type CameraStatus = string;

export interface Camera {
  id: number;
  name: string;
  location?: string;
  rtsp_url?: string;
  bay_number?: number;
  ip_address?: string;
  username?: string;
  password?: string;
  resolution?: string;
  status: string;
  is_active: boolean;
  last_seen?: string;
  snapshot_url?: string;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user?: { id: number; username: string; full_name: string };
  action: string;
  entity_type?: string;
  entity_id?: number;
  description?: string;
  ip_address?: string;
  user_agent?: string;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  created_at: string;
}

export interface DashboardStats {
  total_cars_today: number;
  cars_in_shop: number;
  cars_completed_today: number;
  avg_service_time_minutes: number;
  total_revenue_today: number;
  peak_hour?: string;
  bay_utilization: Record<string, number>;
  active_bays: number;
  total_bays: number;
}

export interface HourlyData {
  hour: string;
  count: number;
  revenue: number;
}

export interface DailyData {
  date: string;
  count: number;
  revenue: number;
  avg_duration: number;
}

export interface AnalyticsReport {
  period_start: string;
  period_end: string;
  total_vehicles: number;
  total_revenue: number;
  avg_service_time: number;
  daily_breakdown: DailyData[];
  bay_utilization: {bay: number; cars_served: number; avg_service_time: number; utilization_percent: number}[];
  top_vehicles: {plate: string; visits: number}[];
  return_rate: number;
}
