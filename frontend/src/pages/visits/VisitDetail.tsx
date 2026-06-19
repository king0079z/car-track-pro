import React, { useMemo, useState, useEffect } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Car, Clock, DollarSign, User, CheckCircle, Edit,
  LogOut, Play, Square, Plus, X, Wrench, Camera, Calendar, Printer,
  FileText, Phone, Mail, PenLine, TrendingUp, BarChart3, Wallet,
  ChevronRight, ScanLine, MessageCircle, Loader2, Send,
} from 'lucide-react';
import { visitsApi, usersApi, servicesApi, vehiclesApi, settingsApi, API_BASE_URL } from '../../services/api';
import {
  fmtQatar,
  fmtQatarDateLong,
  qatarEndOfToday,
  qatarStartOfMonth,
  qatarStartOfWeekMonday,
  qatarYmd,
  qatarYmdAddDays,
  zonedBoundsFromYmd,
} from '../../lib/qatarTime';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import toast from 'react-hot-toast';
import type { Visit, ServiceItem, Service } from '../../types';
import { visitShopDurationMinutes, isActiveVisitStatus } from '../../utils/visitDuration';

const STATUS_CFG: Record<string, { label: string }> = {
  waiting:    { label: 'Waiting' },
  in_service: { label: 'In Service' },
  on_hold:    { label: 'On Hold' },
  completed:  { label: 'Completed' },
  cancelled:  { label: 'Cancelled' },
};

function paymentLabel(status?: string): string {
  const s = (status || 'unpaid').toLowerCase();
  if (s === 'paid') return 'Paid';
  if (s === 'partial' || s === 'partially_paid') return 'Partial';
  return 'Unpaid';
}

const SVC_STATUS: Record<string, { label: string; color: string; next: string; nextLabel: string }> = {
  pending:     { label: 'Pending',     color: '#9ca3af', next: 'in_progress', nextLabel: 'Start Service' },
  in_progress: { label: 'In Progress', color: 'var(--text-accent)', next: 'completed',   nextLabel: 'Mark Done' },
  completed:   { label: 'Completed',   color: 'var(--text-success)', next: '',            nextLabel: '' },
};

function fmtDur(m: number | null | undefined) {
  if (!m) return '—';
  return m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

function fmtCamSec(sec: number) {
  if (!sec || sec <= 0) return '—';
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)} min`;
  return `${Math.round(sec)} s`;
}

const ENTRY_METHOD_LABEL: Record<string, string> = {
  manual: 'Manual registration',
  auto_camera: 'Automatic (camera)',
  qr_code: 'QR code',
};

function resolveMediaUrl(u?: string | null): string | undefined {
  if (!u?.trim()) return undefined;
  const s = u.trim();
  if (s.startsWith('data:') || /^https?:\/\//i.test(s)) return s;
  const path = s.startsWith('/') ? s : `/${s}`;
  return `${API_BASE_URL}${path}`;
}

type AnalyticsRange = 'week' | 'month' | '30d';

function paymentStyle(status?: string): { bg: string; color: string; border: string; label: string } {
  const s = (status || 'unpaid').toLowerCase();
  if (s === 'paid')
    return { bg: 'rgba(16,185,129,0.12)', color: '#34d399', border: 'rgba(16,185,129,0.35)', label: 'Paid' };
  if (s === 'partial' || s === 'partially_paid')
    return { bg: 'rgba(245,158,11,0.12)', color: 'var(--text-warning)', border: 'rgba(245,158,11,0.35)', label: 'Partial' };
  return { bg: 'rgba(251,191,36,0.1)', color: 'var(--text-warning)', border: 'rgba(251,191,36,0.3)', label: 'Unpaid' };
}

function serviceItemDuration(item: ServiceItem): string {
  if (item.actual_duration_minutes != null && item.actual_duration_minutes > 0) {
    return fmtDur(item.actual_duration_minutes);
  }
  if (item.started_at && item.completed_at) {
    const mins = Math.max(1, Math.round(
      (new Date(item.completed_at).getTime() - new Date(item.started_at).getTime()) / 60000,
    ));
    return fmtDur(mins);
  }
  if (item.service?.estimated_duration_minutes) {
    return `~${fmtDur(item.service.estimated_duration_minutes)} est.`;
  }
  return '—';
}

function PrintSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 22, breakInside: 'avoid' as const, pageBreakInside: 'avoid' as const }}>
      <div style={{
        fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: '#64748b', marginBottom: 10, paddingBottom: 8,
        borderBottom: '2px solid #e2e8f0',
      }}>{title}</div>
      {children}
    </section>
  );
}

const SpendTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '12px 16px', fontSize: 12,
      boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
    }}>
      <div style={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>{p.fullLabel}</div>
      <div style={{ color: 'var(--text-purple)', fontWeight: 800, fontSize: 15 }}>QAR {Number(p.revenue).toLocaleString()}</div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>{p.visits} visit{p.visits !== 1 ? 's' : ''}</div>
    </div>
  );
};

export const VisitDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const [staffAssign, setStaffAssign] = useState<Record<number, number>>({});
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showAddService, setShowAddService] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [fixPlateOpen, setFixPlateOpen] = useState(false);
  const [fixPlateValue, setFixPlateValue] = useState('');
  const [addServiceId, setAddServiceId] = useState<number | ''>('');
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>('month');

  const analyticsWindow = useMemo(() => {
    const now = new Date();
    if (analyticsRange === 'week')
      return { start: qatarStartOfWeekMonday(now), end: qatarEndOfToday(now), label: 'This week' };
    if (analyticsRange === 'month')
      return { start: qatarStartOfMonth(now), end: qatarEndOfToday(now), label: 'This month' };
    const start = zonedBoundsFromYmd(qatarYmdAddDays(qatarYmd(now), -29)).start;
    return { start, end: qatarEndOfToday(now), label: 'Last 30 days' };
  }, [analyticsRange]);

  const { data: visit, isLoading } = useQuery({
    queryKey: ['visit', id],
    queryFn: () => visitsApi.get(Number(id)).then(r => r.data),
    enabled: !!id,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (visit && searchParams.get('print') === '1') {
      const t = setTimeout(() => {
        window.print();
        searchParams.delete('print');
        setSearchParams(searchParams, { replace: true });
      }, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visit, searchParams, setSearchParams]);

  const { data: shopSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => settingsApi.public().then(r => r.data as {
      business_name?: string;
      whatsapp_ready?: boolean;
      whatsapp_dry_run?: boolean;
    }),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const { data: catalogServices = [] } = useQuery({
    queryKey: ['services'],
    queryFn: () => servicesApi.list().then(r => r.data as Service[]),
  });

  const vehicleIdForAnalytics = visit?.vehicle_id;
  const { data: vehicleVisits = [], isLoading: analyticsLoading } = useQuery({
    queryKey: [
      'visits', 'vehicle-analytics',
      vehicleIdForAnalytics,
      qatarYmd(analyticsWindow.start),
      qatarYmd(analyticsWindow.end),
    ],
    queryFn: () =>
      visitsApi.list({
        vehicle_id: vehicleIdForAnalytics,
        start_date: qatarYmd(analyticsWindow.start),
        end_date: qatarYmd(analyticsWindow.end),
        limit: 200,
      }).then(r => r.data as Visit[]),
    enabled: !!vehicleIdForAnalytics && !!visit,
  });

  const analyticsSummary = useMemo(() => {
    const n = vehicleVisits.length;
    const total = vehicleVisits.reduce((s, v) => s + (v.total_price || 0), 0);
    const paidSum = vehicleVisits.filter(v => (v.payment_status || '').toLowerCase() === 'paid').reduce((s, v) => s + (v.total_price || 0), 0);
    return {
      count: n,
      total,
      avg: n ? total / n : 0,
      paidSum,
    };
  }, [vehicleVisits]);

  const chartData = useMemo(() => {
    const map = new Map<string, { revenue: number; visits: number }>();
    for (const v of vehicleVisits) {
      const key = qatarYmd(new Date(v.entry_time));
      const cur = map.get(key) || { revenue: 0, visits: 0 };
      cur.revenue += v.total_price || 0;
      cur.visits += 1;
      map.set(key, cur);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, { revenue, visits }]) => ({
        dayShort: fmtQatar(new Date(`${day}T12:00:00+03:00`), 'dateMed'),
        revenue,
        visits,
        fullLabel: fmtQatar(new Date(`${day}T12:00:00+03:00`), 'full'),
      }));
  }, [vehicleVisits]);

  const sortedHistory = useMemo(
    () => [...vehicleVisits].sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()),
    [vehicleVisits],
  );

  const { data: printHistoryVisits = [] } = useQuery({
    queryKey: ['visits', 'vehicle-print-history', vehicleIdForAnalytics],
    queryFn: () =>
      visitsApi.list({
        vehicle_id: vehicleIdForAnalytics!,
        limit: 200,
      }).then(r => r.data as Visit[]),
    enabled: !!vehicleIdForAnalytics && !!visit,
  });

  const sortedPrintHistory = useMemo(
    () => [...printHistoryVisits].sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()),
    [printHistoryVisits],
  );

  const checkoutMutation = useMutation({
    mutationFn: () => visitsApi.checkout(Number(id)),
    onSuccess: () => {
      toast.success('Checked out!');
      qc.invalidateQueries({ queryKey: ['visit', id] });
      qc.invalidateQueries({ queryKey: ['visits', 'vehicle-analytics'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      navigate(`/visits/${id}?print=1`, { replace: true });
    },
    onError: () => toast.error('Checkout failed'),
  });

  const resendWhatsappMutation = useMutation({
    mutationFn: () => visitsApi.resendWhatsapp(Number(id)),
    onSuccess: (res) => {
      const data = res.data as { phone?: string; dry_run?: boolean };
      if (data.dry_run) {
        toast.success(`WhatsApp dry-run OK (logged on server) → +${data.phone || 'customer'}`);
      } else {
        toast.success(data.phone ? `WhatsApp receipt sent to +${data.phone}` : 'WhatsApp receipt sent to customer');
      }
      qc.invalidateQueries({ queryKey: ['visit', id] });
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string | { msg?: string }[] } } };
      const d = err?.response?.data?.detail;
      const msg = typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x?.msg || String(x)).join(', ') : 'Could not send WhatsApp';
      toast.error(msg, { duration: 6000 });
    },
  });

  const fixPlateMutation = useMutation({
    mutationFn: ({ vehicleId, plate, merge }: { vehicleId: number; plate: string; merge: boolean }) =>
      vehiclesApi.correctPlate(vehicleId, plate, merge),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['visit', id] });
      qc.invalidateQueries({ queryKey: ['vehicles'] });
      setFixPlateOpen(false);
      if (res.data?.merged_into) {
        toast.success(`Plate corrected — merged (${res.data.visits_moved ?? 0} visits moved)`);
      } else {
        toast.success('Plate corrected');
      }
    },
    onError: (e: unknown, vars) => {
      const err = e as { response?: { status?: number; data?: { detail?: { hint?: string } | string } } };
      if (err?.response?.status === 409 && !vars.merge) {
        if (window.confirm('That plate already exists on another vehicle. Merge the duplicate records?')) {
          fixPlateMutation.mutate({ ...vars, merge: true });
        }
        return;
      }
      toast.error(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Could not correct plate');
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: (status: string) => visitsApi.update(Number(id), { status }),
    onSuccess: () => { toast.success('Status updated'); setShowStatusModal(false); qc.invalidateQueries({ queryKey: ['visit', id] }); },
    onError: () => toast.error('Update failed'),
  });

  const updateServiceMutation = useMutation({
    mutationFn: ({ itemId, data }: { itemId: number; data: any }) =>
      visitsApi.updateServiceItem(Number(id), itemId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['visit', id] }); qc.invalidateQueries({ queryKey: ['services'] }); },
    onError: () => toast.error('Update failed'),
  });

  const addServiceMutation = useMutation({
    mutationFn: (data: { service_id: number; price?: number; assigned_staff_id?: number }) =>
      visitsApi.addServiceItem(Number(id), data),
    onSuccess: () => {
      toast.success('Service added');
      setShowAddService(false);
      setAddServiceId('');
      qc.invalidateQueries({ queryKey: ['visit', id] });
      qc.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Could not add service'),
  });

  const startService = (item: any) => {
    updateServiceMutation.mutate({
      itemId: item.id,
      data: {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        assigned_staff_id: staffAssign[item.id] || item.assigned_staff_id || undefined,
      },
    });
    // Also update visit status
    if (visit?.status === 'waiting') updateStatusMutation.mutate('in_service');
  };

  const completeService = (item: any) => {
    const now = new Date().toISOString();
    updateServiceMutation.mutate({
      itemId: item.id,
      data: {
        status: 'completed',
        completed_at: now,
      },
    });
  };

  const assignStaff = (itemId: number, staffId: number) => {
    setStaffAssign(p => ({ ...p, [itemId]: staffId }));
    updateServiceMutation.mutate({
      itemId,
      data: { assigned_staff_id: staffId },
    });
  };

  if (isLoading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <div className="spinner" style={{ width: 36, height: 36 }} />
    </div>
  );

  if (!visit) return null;

  const cfg = STATUS_CFG[visit.status] || STATUS_CFG.waiting;
  const isActive = isActiveVisitStatus(visit.status);
  const liveMinutes = Math.floor((Date.now() - new Date(visit.entry_time).getTime()) / 60000);
  const effectiveShopMinutes = visitShopDurationMinutes(visit) ?? (isActive ? liveMinutes : null);
  const durationLabel =
    effectiveShopMinutes != null
      ? `${fmtDur(effectiveShopMinutes)}${isActive && visit.anpr_camera_seconds == null ? ' ⟳' : ''}`
      : '—';

  const sigRaw = (visit.supervisor_signature || visit.customer_signature)?.trim();
  const signatureSrc = sigRaw
    ? (sigRaw.startsWith('data:') || /^https?:\/\//i.test(sigRaw)
      ? sigRaw
      : resolveMediaUrl(sigRaw))
    : undefined;

  const printPlateImg = resolveMediaUrl(visit.plate_image_url);
  const printCamImg = resolveMediaUrl(visit.entry_camera_snapshot);
  const payStyle = paymentStyle(visit.payment_status);

  const printBusinessName = shopSettings?.business_name || 'CarTrack Pro';
  const printCompleted = visit.status === 'completed';
  const printServiceDurationTotal = (visit.service_items ?? []).reduce((sum: number, item: ServiceItem) => {
    if (item.actual_duration_minutes) return sum + item.actual_duration_minutes;
    if (item.started_at && item.completed_at) {
      return sum + Math.max(1, Math.round(
        (new Date(item.completed_at).getTime() - new Date(item.started_at).getTime()) / 60000,
      ));
    }
    return sum + (item.service?.estimated_duration_minutes ?? 0);
  }, 0);

  const customerWhatsAppPhone = (visit.customer_phone || visit.vehicle?.owner_phone || '').trim();
  const whatsappReady = shopSettings?.whatsapp_ready !== false;
  const whatsappDryRun = Boolean(shopSettings?.whatsapp_dry_run);
  const canSendWhatsapp = visit.status === 'completed' && Boolean(customerWhatsAppPhone) && whatsappReady;

  const sendWhatsappCompletion = () => {
    if (visit.status !== 'completed') {
      toast.error('Complete the work order before sending WhatsApp');
      return;
    }
    if (!customerWhatsAppPhone) {
      toast.error('Add a customer phone number on this work order first');
      return;
    }
    if (visit.whatsapp_notified_at && !window.confirm('WhatsApp was already sent. Send the completion receipt again?')) {
      return;
    }
    resendWhatsappMutation.mutate();
  };

  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
        @media print {
          .sidebar,
          .sidebar-overlay,
          .desktop-topbar,
          .mobile-topbar,
          .visit-detail-no-print { display: none !important; }
          .visit-detail-print-only { display: block !important; visibility: visible !important; }
          .app-layout { display: block !important; }
          .app-main { margin: 0 !important; padding: 0 !important; width: 100% !important; }
          .page-container { padding: 0 !important; max-width: none !important; display: block !important; visibility: visible !important; }
          body { background: #fff !important; }
          @page { margin: 10mm 12mm; size: A4; }
        }
        .visit-detail-print-only { display: none; }
      `}</style>

    <div className="visit-detail-no-print vd-page animate-fade-in">
      {/* Top bar */}
      <div className="vd-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/visits')}>
          <ArrowLeft size={14} /> Visits
        </button>
        <span className="vd-toolbar-id">{visit.visit_number}</span>
        <div className="vd-toolbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()} title="Print work order">
            <Printer size={13} /> Print
          </button>
          {canSendWhatsapp && (
            <button
              type="button"
              className="btn btn-sm vd-whatsapp-btn"
              onClick={sendWhatsappCompletion}
              disabled={resendWhatsappMutation.isPending}
              title={`Send completion receipt to ${customerWhatsAppPhone} via WhatsApp`}
            >
              {resendWhatsappMutation.isPending ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <MessageCircle size={13} />
              )}
              {visit.whatsapp_notified_at ? 'Resend WhatsApp' : 'Send WhatsApp'}
            </button>
          )}
          {isActive && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowStatusModal(true)}>
                <Edit size={13} /> Status
              </button>
              <button className="btn btn-success btn-sm" onClick={() => checkoutMutation.mutate()} disabled={checkoutMutation.isPending}>
                {checkoutMutation.isPending ? <div className="spinner" style={{ width: 13, height: 13 }} /> : <LogOut size={14} />}
                Checkout
              </button>
            </>
          )}
        </div>
      </div>

      {/* Hero — everything at a glance */}
      <section className="vd-hero">
        <div className="vd-hero-top">
          <div className="vd-hero-main">
            <div className="vd-plate-row">
              <span className="vd-plate">{visit.vehicle?.plate_number}</span>
              {visit.vehicle_id && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  title="Fix OCR misread"
                  onClick={() => {
                    setFixPlateValue(visit.vehicle?.plate_number || '');
                    setFixPlateOpen(true);
                  }}
                >
                  <PenLine size={12} /> Fix plate
                </button>
              )}
              <span className={`status-pill status-${visit.status}`}>{cfg.label}</span>
              {visit.assigned_bay != null && (
                <span className="vd-bay-pill">Bay {visit.assigned_bay}</span>
              )}
            </div>
            <h1 className="vd-vehicle-title">
              {visit.vehicle?.make ? `${visit.vehicle.make} ${visit.vehicle.model || ''}`.trim() : 'Unknown vehicle'}
              {visit.vehicle?.year && <span className="vd-year">{visit.vehicle.year}</span>}
            </h1>
            <div className="vd-meta-row">
              <span><Calendar size={12} /> {fmtQatar(visit.entry_time, 'full')}</span>
              {visit.customer_name && <span><User size={12} /> {visit.customer_name}</span>}
              {visit.customer_phone && <span><Phone size={12} /> {visit.customer_phone}</span>}
              {visit.status === 'completed' && visit.whatsapp_notified_at && (
                <span title={`WhatsApp sent ${fmtQatar(visit.whatsapp_notified_at, 'full')}`}>
                  <MessageCircle size={12} color="#25D366" /> WhatsApp sent
                </span>
              )}
              {visit.created_by_user && <span><Camera size={12} /> Opened by {visit.created_by_user.full_name}</span>}
              {visit.anpr_camera_name && <span><ScanLine size={12} /> {visit.anpr_camera_name}</span>}
            </div>
          </div>
          <Link to={`/vehicles/${visit.vehicle_id}`} className="btn btn-secondary btn-sm vd-profile-link">
            <Car size={13} /> Vehicle profile
          </Link>
        </div>
        <div className="vd-kpi-row">
          <div className="vd-kpi">
            <Clock size={16} />
            <div><strong>{durationLabel}</strong><span>Duration</span></div>
          </div>
          <div className="vd-kpi accent-purple">
            <DollarSign size={16} />
            <div><strong>QAR {(visit.total_price || 0).toLocaleString()}</strong><span>Total</span></div>
          </div>
          <div className="vd-kpi accent-blue">
            <Wrench size={16} />
            <div><strong>{visit.service_items?.length ?? 0}</strong><span>Services</span></div>
          </div>
          <div className="vd-kpi" style={{ borderColor: payStyle.border }}>
            <CheckCircle size={16} color={payStyle.color} />
            <div><strong style={{ color: payStyle.color }}>{payStyle.label}</strong><span>Payment</span></div>
          </div>
        </div>
      </section>

      {/* Main grid: work order + context */}
      <div className="vd-main-grid">
        {/* Services */}
        <section className="vd-panel vd-panel-primary">
          <div className="vd-panel-head">
            <div className="vd-panel-title">
              <Wrench size={16} /> Work order
              <span className="vd-count">{visit.service_items?.length ?? 0}</span>
            </div>
            {isActive && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAddService(true)}>
                <Plus size={12} /> Add
              </button>
            )}
          </div>
          {!visit.service_items?.length ? (
            <div className="vd-empty">No services on this work order</div>
          ) : (
            <>
              <div className="vd-service-list">
                {visit.service_items.map((item: ServiceItem) => {
                  const svcCfg = SVC_STATUS[item.status] || SVC_STATUS.pending;
                  return (
                    <div key={item.id} className="vd-service-item">
                      <div className="vd-service-item-main">
                        <span className="vd-service-name">{item.service?.name}</span>
                        <span className="vd-service-cat">{item.service?.category}</span>
                        {item.assigned_staff && (
                          <span className="vd-service-staff"><User size={11} /> {item.assigned_staff.full_name}</span>
                        )}
                        {!item.assigned_staff && isActive && (users as any[]).length > 0 && (
                          <select
                            className="vd-staff-select"
                            value={staffAssign[item.id] || ''}
                            onChange={e => e.target.value && assignStaff(item.id, Number(e.target.value))}
                          >
                            <option value="">Assign staff…</option>
                            {(users as any[]).map((u: any) => (
                              <option key={u.id} value={u.id}>{u.full_name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="vd-service-item-end">
                        <span className="vd-svc-status" style={{ color: svcCfg.color, background: `${svcCfg.color}18` }}>{svcCfg.label}</span>
                        <span className="vd-svc-price">QAR {(item.price ?? 0).toLocaleString()}</span>
                        {isActive && item.status !== 'completed' && (
                          <button
                            type="button"
                            className={item.status === 'pending' ? 'btn btn-secondary btn-sm' : 'btn btn-success btn-sm'}
                            onClick={() => item.status === 'pending' ? startService(item) : completeService(item)}
                            disabled={updateServiceMutation.isPending}
                          >
                            {item.status === 'pending' ? <><Play size={11} /> Start</> : <><Square size={11} /> Done</>}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="vd-invoice-total">
                <span>Invoice total</span>
                <strong>QAR {(visit.total_price ?? 0).toLocaleString()}</strong>
              </div>
            </>
          )}
        </section>

        {/* Context sidebar */}
        <aside className="vd-panel vd-panel-aside">
          <div className="vd-panel-head">
            <div className="vd-panel-title"><FileText size={16} /> Registration</div>
          </div>
          <dl className="vd-facts">
            <div><dt>Entry</dt><dd>{ENTRY_METHOD_LABEL[visit.entry_method] || visit.entry_method}</dd></div>
            {visit.anpr_camera_seconds != null && visit.anpr_camera_seconds > 0 && (
              <div><dt>ANPR track</dt><dd>{fmtCamSec(visit.anpr_camera_seconds)} in frame{visit.anpr_camera_name ? ` · ${visit.anpr_camera_name}` : ''}</dd></div>
            )}
            {visit.exit_time && (
              <div><dt>Checkout</dt><dd>{fmtQatar(visit.exit_time, 'full')}</dd></div>
            )}
            {visit.customer_email && (
              <div><dt>Email</dt><dd>{visit.customer_email}</dd></div>
            )}
            {visit.notes && (
              <div className="vd-facts-notes"><dt>Notes</dt><dd>{visit.notes}</dd></div>
            )}
          </dl>

          <div className="vd-whatsapp-card">
            <div className="vd-panel-title small">
              <MessageCircle size={14} /> Customer WhatsApp
            </div>
            {customerWhatsAppPhone ? (
              <p className="vd-whatsapp-phone">
                <Phone size={12} /> {customerWhatsAppPhone}
              </p>
            ) : (
              <p className="vd-whatsapp-hint">No phone on file — add customer phone on the vehicle profile or work order.</p>
            )}
            {!whatsappReady && (
              <p className="vd-whatsapp-warn">
                WhatsApp is not configured on the server. Add <code>WHATSAPP_ENABLED</code>, <code>WHATSAPP_ACCESS_TOKEN</code>, and <code>WHATSAPP_PHONE_NUMBER_ID</code> to backend <code>.env</code>, or set <code>WHATSAPP_DRY_RUN=true</code> for local testing.
              </p>
            )}
            {whatsappDryRun && (
              <p className="vd-whatsapp-dry">Dry-run mode — message is logged on the server, not sent to Meta.</p>
            )}
            {visit.status !== 'completed' ? (
              <p className="vd-whatsapp-hint">Complete checkout to send the work order completion receipt.</p>
            ) : (
              <>
                {visit.whatsapp_notified_at && (
                  <p className="vd-whatsapp-sent">
                    <CheckCircle size={12} /> Sent {fmtQatar(visit.whatsapp_notified_at, 'dmyHm')}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-sm vd-whatsapp-send"
                  onClick={sendWhatsappCompletion}
                  disabled={!customerWhatsAppPhone || !whatsappReady || resendWhatsappMutation.isPending}
                >
                  {resendWhatsappMutation.isPending ? (
                    <><Loader2 size={14} className="spin" /> Sending…</>
                  ) : (
                    <><Send size={14} /> {visit.whatsapp_notified_at ? 'Resend completion receipt' : 'Send completion to WhatsApp'}</>
                  )}
                </button>
              </>
            )}
          </div>

          <div className="vd-signature-block">
            <div className="vd-panel-title small"><PenLine size={14} /> Supervisor sign-off</div>
            {signatureSrc ? (
              <div className="vd-signature-box">
                <img src={signatureSrc} alt="Supervisor signature" />
                {visit.supervisor_signed_by_user && (
                  <p className="vd-sig-name">{visit.supervisor_signed_by_user.full_name}</p>
                )}
                {visit.signature_captured_at && (
                  <p className="vd-sig-time">Signed {fmtQatar(visit.signature_captured_at, 'dmyHm')}</p>
                )}
              </div>
            ) : (
              <div className="vd-empty small">No signature on file</div>
            )}
          </div>
          {(resolveMediaUrl(visit.plate_image_url) || resolveMediaUrl(visit.entry_camera_snapshot)) && (
            <div className="vd-captures">
              <div className="vd-panel-title small">Entry images</div>
              <div className="vd-capture-grid">
                {resolveMediaUrl(visit.plate_image_url) && (
                  <img src={resolveMediaUrl(visit.plate_image_url)} alt="Plate" />
                )}
                {resolveMediaUrl(visit.entry_camera_snapshot) && (
                  <img src={resolveMediaUrl(visit.entry_camera_snapshot)} alt="Camera" />
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Customer history — expandable */}
      <section className="vd-history-section">
        <button type="button" className="vd-history-toggle" onClick={() => setShowHistory(v => !v)}>
          <div className="vd-history-toggle-left">
            <BarChart3 size={18} />
            <div>
              <strong>Customer history</strong>
              <span>{analyticsSummary.count} visit{analyticsSummary.count !== 1 ? 's' : ''} · QAR {Math.round(analyticsSummary.total).toLocaleString()} in {analyticsWindow.label.toLowerCase()}</span>
            </div>
          </div>
          <ChevronRight size={18} className={showHistory ? 'vd-chevron-open' : ''} />
        </button>
        {showHistory && (
        <div className="vd-history-body">
        <div className="vd-history-toolbar">
          <div style={{ display: 'flex', gap: 6, padding: 4, borderRadius: 12, background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
            {([
              { id: 'week' as const, short: 'Week' },
              { id: 'month' as const, short: 'Month' },
              { id: '30d' as const, short: '30 days' },
            ]).map(tab => {
              const on = analyticsRange === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setAnalyticsRange(tab.id)}
                  className={`vd-range-tab${on ? ' active' : ''}`}
                >
                  {tab.short}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ padding: '0 0 8px' }}>
          {analyticsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48, color: 'var(--text-muted)', gap: 10, alignItems: 'center' }}>
              <div className="spinner" style={{ width: 22, height: 22 }} /> Loading analytics…
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 22 }}>
                {[
                  {
                    icon: TrendingUp, title: 'Visits', value: String(analyticsSummary.count),
                    sub: analyticsWindow.label, color: 'var(--text-accent)',
                  },
                  {
                    icon: Wallet, title: 'Total spend', value: `QAR ${Math.round(analyticsSummary.total).toLocaleString()}`,
                    sub: 'Sum of invoice totals', color: 'var(--text-purple)',
                  },
                  {
                    icon: DollarSign, title: 'Avg / visit', value: `QAR ${analyticsSummary.count ? Math.round(analyticsSummary.avg).toLocaleString() : '0'}`,
                    sub: !analyticsSummary.count
                      ? 'No data yet'
                      : analyticsSummary.total > 0
                        ? `${Math.round((analyticsSummary.paidSum / analyticsSummary.total) * 100)}% of spend marked paid`
                        : 'No billed amount in range',
                    color: '#34d399',
                  },
                ].map(({ icon: Icon, title, value, sub, color }) => (
                  <div
                    key={title}
                    style={{
                      padding: '16px 18px', borderRadius: 14,
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-light)',
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon size={16} color={color} />
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{title}</span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>{value}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>{sub}</div>
                  </div>
                ))}
              </div>

              {chartData.length > 0 && (
                <div style={{
                  marginBottom: 22,
                  padding: '16px 12px 8px',
                  borderRadius: 16,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-light)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', margin: '0 8px 12px' }}>
                    Spend by day · QAR
                  </div>
                  <div style={{ width: '100%', height: 220, minWidth: 0, minHeight: 220 }}>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                        <defs>
                          <linearGradient id="visitBarGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.95} />
                            <stop offset="100%" stopColor="#6366f1" stopOpacity={0.35} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 6" stroke="var(--border-light)" opacity={0.6} vertical={false} />
                        <XAxis dataKey="dayShort" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                        <Tooltip content={<SpendTooltip />} cursor={{ fill: 'rgba(139,92,246,0.06)' }} />
                        <Bar dataKey="revenue" name="Spend" fill="url(#visitBarGrad)" radius={[8, 8, 4, 4]} maxBarSize={48} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>
                    Visit ledger · payment per visit
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtQatar(analyticsWindow.start, 'dayMonEn')} — {fmtQatar(analyticsWindow.end, 'medDate')}
                  </span>
                </div>
                {sortedHistory.length === 0 ? (
                  <div style={{
                    textAlign: 'center', padding: '36px 20px', borderRadius: 14,
                    border: '1px dashed var(--border)', color: 'var(--text-muted)', fontSize: 13,
                  }}>
                    No visits for this vehicle in {analyticsWindow.label.toLowerCase()}.
                  </div>
                ) : (
                  <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border-light)', background: 'var(--bg-surface)' }}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-elevated)' }}>
                            {['Visit', 'Date', 'Status', 'Payment', 'Amount', ''].map(h => (
                              <th
                                key={h}
                                style={{
                                  padding: '11px 14px', textAlign: h === '' ? 'right' : 'left',
                                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                                  color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap',
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedHistory.map((v, idx) => {
                            const current = v.id === Number(id);
                            const pay = paymentStyle(v.payment_status);
                            return (
                              <tr
                                key={v.id}
                                onClick={() => !current && navigate(`/visits/${v.id}`)}
                                style={{
                                  borderBottom: idx < sortedHistory.length - 1 ? '1px solid var(--border-light)' : 'none',
                                  background: current ? 'linear-gradient(90deg, rgba(139,92,246,0.14), transparent)' : idx % 2 === 1 ? 'var(--bg-elevated)' : 'transparent',
                                  cursor: current ? 'default' : 'pointer',
                                  transition: 'background 0.15s',
                                }}
                              >
                                <td style={{ padding: '12px 14px', fontFamily: 'monospace', fontWeight: 800, color: 'var(--text-accent)', letterSpacing: '0.04em' }}>
                                  {v.visit_number}
                                  {current && (
                                    <span style={{
                                      marginLeft: 8, fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
                                      padding: '2px 8px', borderRadius: 99,
                                      background: 'rgba(139,92,246,0.15)', color: 'var(--text-purple)', verticalAlign: 'middle',
                                    }}>
                                      This visit
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: '12px 14px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                  {`${fmtQatar(v.entry_time, 'dateMed')} · ${fmtQatar(v.entry_time, 'hm')}`}
                                </td>
                                <td style={{ padding: '12px 14px' }}>
                                  <span className={`status-pill status-${v.status}`} style={{ fontSize: 10 }}>{STATUS_CFG[String(v.status)]?.label ?? v.status}</span>
                                </td>
                                <td style={{ padding: '12px 14px' }}>
                                  <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 5,
                                    padding: '4px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                                    background: pay.bg, color: pay.color, border: `1px solid ${pay.border}`,
                                  }}>
                                    {pay.label}
                                    {v.payment_method ? <span style={{ opacity: 0.85, fontWeight: 600 }}> · {v.payment_method}</span> : null}
                                  </span>
                                </td>
                                <td style={{ padding: '12px 14px', fontWeight: 800, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: 'var(--text-purple)' }}>
                                  QAR {(v.total_price ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                </td>
                                <td style={{ padding: '12px 14px', textAlign: 'right', color: 'var(--text-muted)' }}>
                                  {!current ? <ChevronRight size={16} /> : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        </div>
        )}
      </section>

      {/* Add service modal */}
      {showAddService && (
        <div className="modal-backdrop" onClick={() => setShowAddService(false)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Add service</h2>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShowAddService(false)}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                Service from catalog
                <select
                  className="input"
                  style={{ marginTop: 6, width: '100%' }}
                  value={addServiceId}
                  onChange={e => setAddServiceId(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">Select service…</option>
                  {(catalogServices as Service[])
                    .filter(s => s.is_active !== false)
                    .filter(s => !visit.service_items?.some((si: ServiceItem) => si.service_id === s.id))
                    .map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} · QAR {s.base_price.toLocaleString()} · ~{s.estimated_duration_minutes}m
                      </option>
                    ))}
                </select>
              </label>
              {addServiceId && (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                  Price defaults to catalog base rate. Invoice total updates automatically.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setShowAddService(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!addServiceId || addServiceMutation.isPending}
                onClick={() => {
                  const svc = (catalogServices as Service[]).find(s => s.id === addServiceId);
                  if (svc) addServiceMutation.mutate({ service_id: svc.id, price: svc.base_price });
                }}
              >
                {addServiceMutation.isPending ? 'Adding…' : 'Add to work order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Modal */}
      {showStatusModal && (
        <div className="modal-backdrop" onClick={() => setShowStatusModal(false)}>
          <div className="modal-box" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Update Status</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowStatusModal(false)}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(['waiting', 'in_service', 'on_hold', 'completed', 'cancelled'] as const).map(s => {
                const c = STATUS_CFG[s];
                const isActive = visit.status === s;
                return (
                  <button
                    key={s}
                    onClick={() => updateStatusMutation.mutate(s)}
                    disabled={isActive || updateStatusMutation.isPending}
                    className={isActive ? `status-pill status-${s}` : ''}
                    style={{
                      padding: '12px 16px', borderRadius: 8,
                      border: `1px solid var(--border)`,
                      background: isActive ? undefined : 'var(--bg-elevated)',
                      color: isActive ? undefined : 'var(--text-secondary)',
                      cursor: isActive ? 'default' : 'pointer',
                      fontSize: 13, fontWeight: 600, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />
                    {c.label}
                    {visit.status === s && <span style={{ marginLeft: 'auto', fontSize: 10 }}>Current</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {fixPlateOpen && visit.vehicle_id && (
        <div className="modal-backdrop" onClick={() => setFixPlateOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Fix plate (OCR correction)</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setFixPlateOpen(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Correct a misread plate. If the correct plate already exists, you can merge duplicate vehicle records.
              </p>
              <input
                type="text"
                value={fixPlateValue}
                onChange={e => setFixPlateValue(e.target.value.toUpperCase())}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontFamily: 'monospace', fontWeight: 700 }}
                autoFocus
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 14, width: '100%' }}
                disabled={fixPlateMutation.isPending || fixPlateValue.trim().length < 2}
                onClick={() => fixPlateMutation.mutate({
                  vehicleId: visit.vehicle_id,
                  plate: fixPlateValue.trim(),
                  merge: false,
                })}
              >
                {fixPlateMutation.isPending ? 'Saving…' : 'Save corrected plate'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>

    {/* ── Print-only: full visit + customer history (vehicle) ───────────────── */}
    <div
      className="visit-detail-print-only"
      style={{
        fontFamily: "'Segoe UI', ui-sans-serif, system-ui, sans-serif",
        color: '#0f172a',
        fontSize: 10.5,
        lineHeight: 1.5,
        maxWidth: 720,
        margin: '0 auto',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      <header style={{
        background: 'linear-gradient(135deg, #1e40af 0%, #5b21b6 55%, #7c3aed 100%)',
        color: '#fff',
        padding: '22px 26px',
        borderRadius: 0,
      }}>
        <div style={{ fontSize: 9, letterSpacing: '0.22em', textTransform: 'uppercase', opacity: 0.88 }}>{printBusinessName}</div>
        <h1 style={{ margin: '10px 0 0', fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em' }}>
          {printCompleted ? 'Work order completion report' : 'Work order report'}
        </h1>
        <p style={{ margin: '10px 0 0', fontSize: 11, opacity: 0.92 }}>
          {visit.visit_number} · {`${fmtQatarDateLong()} · ${fmtQatar(new Date(), 'hm')}`}
        </p>
        {printCompleted && effectiveShopMinutes != null && (
          <div style={{
            marginTop: 14, display: 'inline-block', padding: '8px 14px',
            background: 'rgba(255,255,255,0.16)', borderRadius: 8, fontSize: 12, fontWeight: 800,
          }}>
            Total time in shop: {fmtDur(effectiveShopMinutes)}
          </div>
        )}
      </header>

      <PrintSection title="Time & duration">
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
          marginBottom: 12,
        }}>
          {[
            { label: 'Arrived', value: fmtQatar(visit.entry_time, 'pp') },
            { label: 'Completed', value: visit.exit_time ? fmtQatar(visit.exit_time, 'pp') : (isActive ? 'In progress' : '—') },
            { label: 'Shop duration', value: effectiveShopMinutes != null ? fmtDur(effectiveShopMinutes) : '—' },
          ].map(box => (
            <div key={box.label} style={{ padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: '#64748b', textTransform: 'uppercase' }}>{box.label}</div>
              <div style={{ fontSize: 12, fontWeight: 800, marginTop: 6, color: '#0f172a' }}>{box.value}</div>
            </div>
          ))}
        </div>
        {printServiceDurationTotal > 0 && (
          <div style={{ fontSize: 10, color: '#475569' }}>
            Service time (est./actual): <strong>{fmtDur(printServiceDurationTotal)}</strong>
          </div>
        )}
      </PrintSection>

      <PrintSection title="Visit & vehicle">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['Work order #', visit.visit_number],
              ['Status', STATUS_CFG[String(visit.status)]?.label ?? visit.status],
              ['Plate', visit.vehicle?.plate_number ?? '—'],
              ['Vehicle', visit.vehicle?.make ? `${visit.vehicle.make} ${visit.vehicle.model || ''}${visit.vehicle.year ? ` · ${visit.vehicle.year}` : ''}` : '—'],
              ['VIN', visit.vehicle?.vin || '—'],
              ['Colour', visit.vehicle?.color || '—'],
              ['Bay', visit.assigned_bay != null ? `Bay ${visit.assigned_bay}` : '—'],
              ['Entry', fmtQatar(visit.entry_time, 'pp')],
              ['Exit', visit.exit_time ? fmtQatar(visit.exit_time, 'pp') : '—'],
              ...(visit.anpr_camera_seconds != null && visit.anpr_camera_seconds > 0
                ? [['ANPR camera track', fmtCamSec(visit.anpr_camera_seconds)] as [string, string]]
                : []),
              ['Duration', effectiveShopMinutes != null ? fmtDur(effectiveShopMinutes) : '—'],
              ['Logged by', visit.created_by_user?.full_name ?? '—'],
            ].map(([k, v]) => (
              <tr key={String(k)} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '7px 8px 7px 0', width: '32%', fontWeight: 700, color: '#475569', verticalAlign: 'top' }}>{k}</td>
                <td style={{ padding: '7px 0', color: '#0f172a', verticalAlign: 'top' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PrintSection>

      <PrintSection title="Customer">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['Name on visit', visit.customer_name || visit.vehicle?.owner_name || '—'],
              ['Phone', visit.customer_phone || visit.vehicle?.owner_phone || '—'],
              ['Email', visit.customer_email || visit.vehicle?.owner_email || '—'],
              ['Entry method', ENTRY_METHOD_LABEL[visit.entry_method] || visit.entry_method],
            ].map(([k, v]) => (
              <tr key={String(k)} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '7px 8px 7px 0', width: '32%', fontWeight: 700, color: '#475569' }}>{k}</td>
                <td style={{ padding: '7px 0' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PrintSection>

      <PrintSection title="Charges & payment">
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12, marginBottom: 14, padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
        }}>
          <div>
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: '#64748b', textTransform: 'uppercase' }}>Invoice total</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#4c1d95', marginTop: 4 }}>QAR {(visit.total_price ?? 0).toLocaleString()}</div>
          </div>
          <div>
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: '#64748b', textTransform: 'uppercase' }}>Payment status</div>
            <div style={{ fontSize: 14, fontWeight: 800, marginTop: 6 }}>{paymentStyle(visit.payment_status).label}</div>
          </div>
          <div>
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: '#64748b', textTransform: 'uppercase' }}>Method</div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>{visit.payment_method || '—'}</div>
          </div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              {['Service', 'Category', 'Staff', 'Duration', 'Line status', 'QAR'].map(h => (
                <th key={h} style={{ textAlign: h === 'QAR' ? 'right' : 'left', padding: '8px 10px', borderBottom: '2px solid #cbd5e1', fontSize: 8, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#475569' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(visit.service_items ?? []).length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 12, color: '#64748b' }}>No line items</td></tr>
            ) : (
              visit.service_items!.map((item: ServiceItem) => (
                <tr key={item.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 700 }}>{item.service?.name ?? '—'}</td>
                  <td style={{ padding: '8px 10px', textTransform: 'capitalize', color: '#475569' }}>{item.service?.category ?? '—'}</td>
                  <td style={{ padding: '8px 10px' }}>{item.assigned_staff?.full_name ?? '—'}</td>
                  <td style={{ padding: '8px 10px', fontWeight: 700, color: '#334155' }}>{serviceItemDuration(item)}</td>
                  <td style={{ padding: '8px 10px' }}>{SVC_STATUS[item.status]?.label ?? item.status}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 900, fontFamily: 'ui-monospace, monospace', color: '#5b21b6' }}>{(item.price ?? 0).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PrintSection>

      <PrintSection title="Notes & registration">
        {visit.notes ? (
          <div style={{ padding: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, whiteSpace: 'pre-wrap' }}>{visit.notes}</div>
        ) : (
          <div style={{ color: '#64748b' }}>No visit notes.</div>
        )}
        {visit.plate_confidence != null && visit.plate_confidence > 0 && (
          <div style={{ marginTop: 10, fontSize: 10, color: '#475569' }}>
            Plate read confidence: <strong>{(visit.plate_confidence * 100).toFixed(0)}%</strong>
          </div>
        )}
      </PrintSection>

      <PrintSection title="Supervisor sign-off">
        {signatureSrc ? (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#fff', breakInside: 'avoid' as const }}>
            <img src={signatureSrc} alt="" style={{ maxWidth: 280, maxHeight: 100, display: 'block' }} />
            {visit.supervisor_signed_by_user && (
              <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', marginTop: 8 }}>
                {visit.supervisor_signed_by_user.full_name}
              </div>
            )}
            {visit.signature_captured_at && (
              <div style={{ fontSize: 9, color: '#64748b', marginTop: 4 }}>Signed {fmtQatar(visit.signature_captured_at, 'pp')}</div>
            )}
          </div>
        ) : (
          <div style={{ color: '#64748b', fontSize: 10 }}>No supervisor signature on file.</div>
        )}
      </PrintSection>

        {(printPlateImg || printCamImg) && (
          <PrintSection title="Camera captures">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {printPlateImg && (
              <div style={{ breakInside: 'avoid' as const }}>
                <div style={{ fontSize: 8, fontWeight: 800, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Plate image</div>
                <img src={printPlateImg} alt="" style={{ width: 160, height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
              </div>
            )}
            {printCamImg && (
              <div style={{ breakInside: 'avoid' as const }}>
                <div style={{ fontSize: 8, fontWeight: 800, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Entry snapshot</div>
                <img src={printCamImg} alt="" style={{ width: 160, height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
              </div>
            )}
          </div>
          </PrintSection>
        )}

      <PrintSection title={`Customer visit history · same vehicle · ${sortedPrintHistory.length} record${sortedPrintHistory.length !== 1 ? 's' : ''}`}>
        <p style={{ margin: '0 0 12px', fontSize: 10, color: '#475569' }}>
          All visits linked to plate <strong>{visit.vehicle?.plate_number}</strong> in CarTrack (up to 200 most recent).
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9.5 }}>
          <thead>
            <tr style={{ background: '#1e293b', color: '#fff' }}>
              {['Visit #', 'Date & time', 'Status', 'Duration', 'Payment', 'Amount (QAR)'].map(h => (
                <th key={h} style={{
                  textAlign: h.includes('Amount') ? 'right' : 'left',
                  padding: '9px 10px',
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedPrintHistory.map(v => {
              const isCur = v.id === Number(id);
              const pay = paymentStyle(v.payment_status);
              return (
                <tr
                  key={v.id}
                  style={{
                    borderBottom: '1px solid #e2e8f0',
                    background: isCur ? '#eef2ff' : undefined,
                    outline: isCur ? '2px solid #6366f1' : undefined,
                  }}
                >
                  <td style={{ padding: '8px 10px', fontWeight: 800, fontFamily: 'ui-monospace, monospace' }}>
                    {v.visit_number}{isCur ? ' · current' : ''}
                  </td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtQatar(v.entry_time, 'dmyHm')}</td>
                  <td style={{ padding: '8px 10px' }}>{STATUS_CFG[String(v.status)]?.label ?? v.status}</td>
                  <td style={{ padding: '8px 10px' }}>{v.duration_minutes != null ? fmtDur(v.duration_minutes) : '—'}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 99,
                      fontWeight: 800,
                      fontSize: 8.5,
                      background: pay.bg,
                      color: pay.color,
                      border: `1px solid ${pay.border}`,
                    }}>
                      {pay.label}{v.payment_method ? ` · ${v.payment_method}` : ''}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 900, fontFamily: 'ui-monospace, monospace', color: '#5b21b6', fontSize: 11 }}>
                    {(v.total_price ?? 0).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </PrintSection>

      <footer style={{
        marginTop: 28,
        paddingTop: 14,
        borderTop: '1px solid #cbd5e1',
        fontSize: 9,
        color: '#94a3b8',
        textAlign: 'center',
      }}>
        {printBusinessName} · Work order documentation · Confidential
      </footer>
    </div>
    </>
  );
};
