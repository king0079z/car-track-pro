import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Shield, Search, X, Eye, Plus, Edit, Trash2, LogIn, LogOut,
  Brain, Sparkles, Clock, Car, Camera, ArrowRight, RefreshCw,
  ChevronDown, ChevronUp, Activity, DollarSign, Gauge, ScanLine,
  AlertTriangle, Lightbulb, BarChart3, Wrench, Layers, Download, FileJson, Bug,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { auditApi, analyticsApi, anprApi } from '../services/api';
import { formatDistanceToNow } from 'date-fns';
import { fmtQatar } from '../lib/qatarTime';
import type { AuditLog } from '../types';

const LOG_LIMIT = 40;
const ERROR_LOG_MODAL_LIMIT = 45;
/** Auto-captured browser errors + optional manual “Report system error” rows */
const SYSTEM_ERROR_ACTIONS_CSV = 'client_auto_error,system_error_report';
const INSIGHT_DAYS = 30;

type InsightTone = 'revenue' | 'throughput' | 'vision' | 'risk' | 'ops';

interface OperationalInsight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
  metric?: string;
  action?: { label: string; to: string };
}

const ACTION_CFG: Record<string, { badgeClass: string; icon: React.ReactNode }> = {
  create: { badgeClass: 'badge badge-green', icon: <Plus size={12} /> },
  update: { badgeClass: 'badge badge-blue', icon: <Edit size={12} /> },
  delete: { badgeClass: 'badge badge-red', icon: <Trash2 size={12} /> },
  login: { badgeClass: 'badge badge-purple', icon: <LogIn size={12} /> },
  logout: { badgeClass: 'badge badge-gray', icon: <LogOut size={12} /> },
  checkout: { badgeClass: 'badge badge-yellow', icon: <LogOut size={12} /> },
  view: { badgeClass: 'badge badge-cyan', icon: <Eye size={12} /> },
  periodic_audit: { badgeClass: 'badge badge-purple', icon: <RefreshCw size={12} /> },
  system_error_report: { badgeClass: 'badge badge-red', icon: <Bug size={12} /> },
  client_auto_error: { badgeClass: 'badge badge-red', icon: <AlertTriangle size={12} /> },
};

const ENTITY_COLORS: Record<string, string> = {
  visit: 'var(--text-accent)',
  vehicle: '#34d399',
  service: '#a78bfa',
  user: '#f87171',
  camera: 'var(--text-warning)',
  setting: '#f472b6',
  incident: '#fb923c',
  client_error: '#f87171',
};

const INSIGHT_STYLE: Record<InsightTone, { border: string; glow: string; icon: typeof Sparkles }> = {
  revenue: { border: 'rgba(167,139,250,0.45)', glow: 'rgba(167,139,250,0.08)', icon: DollarSign },
  throughput: { border: 'rgba(251,191,36,0.45)', glow: 'rgba(251,191,36,0.07)', icon: Clock },
  vision: { border: 'rgba(34,211,238,0.45)', glow: 'rgba(34,211,238,0.07)', icon: Camera },
  risk: { border: 'rgba(248,113,113,0.45)', glow: 'rgba(248,113,113,0.06)', icon: AlertTriangle },
  ops: { border: 'rgba(59,130,246,0.45)', glow: 'rgba(59,130,246,0.08)', icon: Activity },
};

function buildOperationalInsights(args: {
  days: number;
  stats: Record<string, unknown> | undefined;
  services: { service_name?: string; count?: number; total_revenue?: number }[] | undefined;
  serviceDuration: {
    service_name?: string;
    estimated_duration?: number;
    avg_actual_minutes?: number;
    avg_actual_duration?: number;
    efficiency?: number | null;
    count?: number;
  }[] | undefined;
  vehicleTypes: {
    vehicle_type?: string;
    avg_duration_minutes?: number;
    count?: number;
    avg_revenue?: number;
  }[] | undefined;
  dashboard: Record<string, unknown> | undefined;
  anpr: Record<string, unknown> | undefined;
  logs: AuditLog[];
}): OperationalInsight[] {
  const out: OperationalInsight[] = [];
  const {
    days,
    stats,
    services = [],
    serviceDuration = [],
    vehicleTypes = [],
    dashboard,
    anpr,
    logs,
  } = args;

  const totalRev = (services as { total_revenue?: number }[]).reduce((s, x) => s + (Number(x.total_revenue) || 0), 0);
  const sortedSvc = [...services].sort((a, b) => (Number(b.total_revenue) || 0) - (Number(a.total_revenue) || 0));
  const top = sortedSvc[0];
  const topShare = totalRev > 0 && top?.total_revenue ? Math.round(((Number(top.total_revenue) || 0) / totalRev) * 100) : 0;

  if (top?.service_name && topShare >= 42) {
    out.push({
      id: 'rev-concentration',
      tone: 'revenue',
      title: `Revenue concentrated in “${top.service_name}”`,
      detail: `${topShare}% of service revenue in the last ${days} days comes from one SKU. Consider bundles and upsells on adjacent services to deepen ticket size without over-relying on a single line.`,
      metric: `${topShare}% · top SKU`,
      action: { label: 'Service catalogue', to: '/services' },
    });
  }

  const slowDur = [...serviceDuration].filter(s => {
    const est = Number(s.estimated_duration) || 0;
    const act = Number(s.avg_actual_minutes ?? s.avg_actual_duration) || 0;
    const eff = s.efficiency;
    if (eff != null && eff < 78 && (s.count ?? 0) >= 2) return true;
    if (est > 0 && act > est * 1.28 && (s.count ?? 0) >= 2) return true;
    return false;
  }).slice(0, 3);

  slowDur.forEach((s, i) => {
    const act = Number(s.avg_actual_minutes ?? s.avg_actual_duration) || 0;
    const est = Number(s.estimated_duration) || 0;
    out.push({
      id: `slow-svc-${i}-${s.service_name}`,
      tone: 'throughput',
      title: `Throughput drift · ${s.service_name}`,
      detail:
        est > 0
          ? `Actual ~${Math.round(act)}m vs estimated ${est}m across ${s.count ?? 0} jobs. Review bay staging, staff handoffs, or whether estimates need updating in the catalogue.`
          : `Efficiency signal is weak (${s.efficiency ?? '—'}%) with ${s.count ?? 0} completions — validate timings on the shop floor.`,
      metric: est ? `${Math.round(act)}m vs ${est}m est` : `${s.efficiency ?? '—'}% eff`,
      action: { label: 'Duration analytics', to: '/analytics?tab=services' },
    });
  });

  const vt = [...vehicleTypes].sort(
    (a, b) => (Number(b.avg_duration_minutes) || 0) - (Number(a.avg_duration_minutes) || 0),
  )[0];
  if (vt?.vehicle_type && (vt.avg_duration_minutes ?? 0) > 75 && (vt.count ?? 0) >= 2) {
    out.push({
      id: 'fleet-dwell',
      tone: 'throughput',
      title: `${vt.vehicle_type} stays longest on average`,
      detail: `Roughly ${Math.round(vt.avg_duration_minutes ?? 0)} minutes average dwell across ${vt.count} visits — schedule longer bays or pre-stage consumables for this body type.`,
      metric: `${Math.round(vt.avg_duration_minutes ?? 0)}m avg`,
      action: { label: 'Vehicle analytics', to: '/vehicles' },
    });
  }

  const totalCars = Number(stats?.total_cars ?? 0);
  const carsDone = Number((stats as { cars_completed?: number })?.cars_completed ?? 0);
  const completionPct = totalCars > 0 ? Math.round((carsDone / totalCars) * 100) : 100;
  if (completionPct < 58 && totalCars > 6) {
    out.push({
      id: 'completion-gap',
      tone: 'ops',
      title: 'Completion rate below target band',
      detail: `${completionPct}% of visits in the window are completed — open jobs inflate duration metrics and hide true revenue. Prioritize checkout on aging visits.`,
      metric: `${completionPct}% completed`,
      action: { label: 'Live visits', to: '/visits' },
    });
  }

  const avgDur = Number(stats?.avg_duration_minutes ?? 0);
  if (avgDur > 95 && totalCars > 5) {
    out.push({
      id: 'elevated-dwell-global',
      tone: 'ops',
      title: 'Shop-wide dwell is elevated',
      detail: `Average ${Math.round(avgDur)} minutes per visit over ${days} days — align with peak hour (${stats?.peak_hour ?? '?'}:00) staffing and in-progress visit reviews.`,
      metric: `${Math.round(avgDur)}m avg`,
      action: { label: 'Dashboard', to: '/' },
    });
  }

  const pending = Number(dashboard?.anpr_pending_visits ?? 0);
  if (pending > 0) {
    out.push({
      id: 'anpr-pending',
      tone: 'vision',
      title: 'ANPR reads waiting for a visit',
      detail: `${pending} camera detections still need linkage to CarTrack visits — clearing them improves plate-to-revenue traceability and reduces duplicate manual entry.`,
      metric: `${pending} pending`,
      action: { label: 'VisionFlow', to: '/visionflow' },
    });
  }

  const totalSynced = Number(anpr?.total_synced ?? 0);
  const linked = Number(anpr?.linked_to_vehicle ?? 0);
  const linkPct = totalSynced > 0 ? Math.round((linked / totalSynced) * 100) : 100;
  if (totalSynced > 15 && linkPct < 72) {
    out.push({
      id: 'anpr-link-rate',
      tone: 'vision',
      title: 'Vehicle linkage rate is soft',
      detail: `${linkPct}% of stored detections tie to a registered vehicle — register frequent plates and sync jobs after VisionFlow runs so analytics stay trustworthy.`,
      metric: `${linkPct}% linked`,
      action: { label: 'Registry', to: '/vehicles' },
    });
  }

  const td = Number(anpr?.today_detections ?? 0);
  const tu = Number(anpr?.today_unique_plates ?? 0);
  if (td > 20 && tu > 0 && td / tu > 1.65) {
    out.push({
      id: 'camera-duplicates',
      tone: 'vision',
      title: 'High duplicate-read ratio today',
      detail: `Many reads per unique plate (${td} detections / ${tu} plates) — typical when shutter speed overlaps tracks or the ROI is wide. Tighten crop toward the lane plate line or raise capture threshold to improve clarity.`,
      metric: `${(td / tu).toFixed(1)}× reads/plate`,
      action: { label: 'ANPR workspace', to: '/visionflow' },
    });
  }

  if (linkPct >= 88 && pending === 0 && td > 5) {
    out.push({
      id: 'vision-healthy',
      tone: 'vision',
      title: 'Vision pipeline looks healthy',
      detail: 'Linkage rate is solid and pending queue is clear — maintain job sync after each analysis batch.',
      metric: `${linkPct}% linked`,
      action: { label: 'Analysis history', to: '/visionflow/history' },
    });
  }

  const deletes = logs.filter(l => String(l.action).toLowerCase() === 'delete').length;
  if (logs.length >= 12 && deletes >= 4) {
    out.push({
      id: 'audit-deletes',
      tone: 'risk',
      title: 'Elevated delete activity in recent audit window',
      detail: `${deletes} delete actions in the latest ${logs.length} logged events — confirm retention policy and that removals were intentional.`,
      metric: `${deletes} deletes`,
      action: { label: 'Users', to: '/users' },
    });
  }

  const peak = stats?.peak_hour;
  if (peak != null && peak !== '') {
    out.push({
      id: 'peak-hour',
      tone: 'ops',
      title: `Peak arrivals · ${peak}:00`,
      detail: 'Align greeters, bay assignment, and camera monitoring around this hour to protect SLA and plate capture quality.',
      metric: `Peak ${peak}:00`,
      action: { label: 'Analytics', to: '/analytics' },
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'balanced',
      tone: 'ops',
      title: 'No critical operational signals',
      detail: `Keep logging visits and service timings — the audit AI refreshes with your last ${days} days of analytics and live ANPR stats.`,
      action: { label: 'New visit', to: '/visits/new' },
    });
  }

  return out.slice(0, 14);
}

function JsonPeek({ label, data }: { label: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(data, null, 2);
  if (!text || text === '{}') return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ fontSize: 11, padding: '4px 8px' }}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {label}
      </button>
      {open && (
        <pre style={{
          marginTop: 8,
          padding: 12,
          borderRadius: 10,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-light)',
          fontSize: 10.5,
          overflow: 'auto',
          maxHeight: 200,
          color: 'var(--text-secondary)',
          fontFamily: 'ui-monospace, monospace',
        }}>
          {text}
        </pre>
      )}
    </div>
  );
}

export const Audit: React.FC = () => {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [reportDays, setReportDays] = useState(30);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [errorLogsOpen, setErrorLogsOpen] = useState(false);
  const [errorLogPage, setErrorLogPage] = useState(1);
  const [incidentSummary, setIncidentSummary] = useState('');
  const [incidentDetails, setIncidentDetails] = useState('');
  const [incidentPath, setIncidentPath] = useState(() =>
    typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search || ''}` : '',
  );

  const incidentMutation = useMutation({
    mutationFn: () =>
      auditApi.reportIncident({
        summary: incidentSummary.trim(),
        details: incidentDetails.trim(),
        page_path: incidentPath.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Error report saved to audit log — expand “New values” on the row for full details');
      setIncidentOpen(false);
      setIncidentSummary('');
      setIncidentDetails('');
      setIncidentPath(typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search || ''}` : '');
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      const msg = Array.isArray(d) ? d[0]?.msg : typeof d === 'string' ? d : null;
      toast.error(msg || 'Could not save report');
    },
  });

  const snapshotMutation = useMutation({
    mutationFn: () => auditApi.snapshot(),
    onSuccess: () => {
      toast.success('Operational snapshot saved to audit log');
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: () => toast.error('Could not run snapshot'),
  });

  const downloadReport = async (fmt: 'csv' | 'json') => {
    try {
      const res = await auditApi.report({ format: fmt, days: reportDays });
      const blob = res.data as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cartrack-audit-report-${reportDays}d.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Report downloaded (${fmt.toUpperCase()})`);
    } catch {
      toast.error('Report download failed');
    }
  };

  const { data: logData, isLoading } = useQuery({
    queryKey: ['audit', page, action, entity],
    queryFn: () =>
      auditApi.list({ page, limit: LOG_LIMIT, action: action || undefined, entity_type: entity || undefined }).then(r => r.data),
  });

  const logs: AuditLog[] = useMemo(() => (Array.isArray(logData) ? logData : []), [logData]);

  const {
    data: errorLogData,
    isLoading: errorLogsLoading,
    isFetching: errorLogsFetching,
    refetch: refetchErrorLogs,
  } = useQuery({
    queryKey: ['audit', 'system-error-logs', errorLogPage],
    queryFn: () =>
      auditApi
        .list({
          page: errorLogPage,
          limit: ERROR_LOG_MODAL_LIMIT,
          actions: SYSTEM_ERROR_ACTIONS_CSV,
        })
        .then(r => r.data),
    enabled: errorLogsOpen,
  });
  const errorLogs: AuditLog[] = Array.isArray(errorLogData) ? errorLogData : [];
  const errorLogsHasNext = errorLogs.length >= ERROR_LOG_MODAL_LIMIT;

  const { data: stats } = useQuery({
    queryKey: ['analytics', INSIGHT_DAYS],
    queryFn: () => analyticsApi.summary({ days: INSIGHT_DAYS }).then(r => r.data),
  });

  const { data: services } = useQuery({
    queryKey: ['analytics-services', INSIGHT_DAYS],
    queryFn: () => analyticsApi.byService({ days: INSIGHT_DAYS }).then(r => r.data),
  });

  const { data: serviceDuration } = useQuery({
    queryKey: ['analytics-service-duration', INSIGHT_DAYS],
    queryFn: () => analyticsApi.serviceDuration({ days: INSIGHT_DAYS }).then(r => r.data),
  });

  const { data: vehicleTypes } = useQuery({
    queryKey: ['analytics-vehicle-types', INSIGHT_DAYS],
    queryFn: () => analyticsApi.byVehicleType({ days: INSIGHT_DAYS }).then(r => r.data),
  });

  const { data: dashboard } = useQuery({
    queryKey: ['analytics-dashboard'],
    queryFn: () => analyticsApi.dashboard().then(r => r.data),
    refetchInterval: 60000,
  });

  const { data: anpr } = useQuery({
    queryKey: ['anpr-stats'],
    queryFn: () => anprApi.stats().then(r => r.data),
    refetchInterval: 90000,
  });

  const operationalInsights = useMemo(
    () =>
      buildOperationalInsights({
        days: INSIGHT_DAYS,
        stats: stats as Record<string, unknown> | undefined,
        services,
        serviceDuration,
        vehicleTypes,
        dashboard: dashboard as Record<string, unknown> | undefined,
        anpr: anpr as Record<string, unknown> | undefined,
        logs,
      }),
    [stats, services, serviceDuration, vehicleTypes, dashboard, anpr, logs],
  );

  const filtered = logs.filter(
    l =>
      !search ||
      l.user?.username?.toLowerCase().includes(search.toLowerCase()) ||
      l.entity_type?.toLowerCase().includes(search.toLowerCase()) ||
      l.action?.toLowerCase().includes(search.toLowerCase()) ||
      l.description?.toLowerCase().includes(search.toLowerCase()),
  );

  const actions = [...new Set(logs.map(l => l.action))].filter(Boolean);
  const entities = [...new Set(logs.map(l => l.entity_type))].filter(Boolean);

  const totalSynced = Number(anpr?.total_synced ?? 0);
  const linked = Number(anpr?.linked_to_vehicle ?? 0);
  const linkPct = totalSynced > 0 ? Math.round((linked / totalSynced) * 100) : null;

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['audit'] });
    qc.invalidateQueries({ queryKey: ['analytics'] });
    qc.invalidateQueries({ queryKey: ['analytics-services'] });
    qc.invalidateQueries({ queryKey: ['analytics-service-duration'] });
    qc.invalidateQueries({ queryKey: ['analytics-vehicle-types'] });
    qc.invalidateQueries({ queryKey: ['analytics-dashboard'] });
    qc.invalidateQueries({ queryKey: ['anpr-stats'] });
  };

  const hasNextPage = logs.length >= LOG_LIMIT;
  const showPagination = page > 1 || hasNextPage;

  return (
    <div className="animate-fade-in">
      <style>{`
        @keyframes audit-shimmer { 0%{background-position:0% 50%} 100%{background-position:200% 50%} }
        @keyframes audit-slide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes audit-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      {/* Hero */}
      <div style={{
        position: 'relative',
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 22,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(139,92,246,0.07) 40%, rgba(15,118,110,0.06) 100%)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.035) 50%, transparent 62%)',
          backgroundSize: '200% 100%',
          animation: 'audit-shimmer 14s ease infinite',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', padding: '26px 28px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 54, height: 54, borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(99,102,241,0.35), rgba(45,212,191,0.22))',
                border: '1px solid rgba(165,180,252,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 14px 44px rgba(99,102,241,0.2)',
              }}>
                <Brain size={28} color="#e0e7ff" />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  <h1 className="page-title" style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Audit &amp; operational AI</h1>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                    padding: '5px 12px', borderRadius: 99,
                    background: 'rgba(139,92,246,0.18)', color: '#d8b4fe', border: '1px solid rgba(167,139,250,0.35)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#a78bfa', animation: 'audit-pulse 2.2s ease infinite' }} />
                    Live synthesis
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 620, lineHeight: 1.65 }}>
                  The <strong style={{ color: 'var(--text-primary)' }}>activity log</strong> stores sign-ins, visit actions,{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>automatic operational audits</strong>, and{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>auto-captured client errors</strong> (
                  <code style={{ fontSize: 12 }}>client_auto_error</code>
                  ) — runtime JS, failed assets, code-splitting chunk failures, CSP blocks, browser reporting API signals, throttled{' '}
                  <code style={{ fontSize: 12 }}>console.error</code>/<code style={{ fontSize: 12 }}>warn</code>, REST faults (5xx / timeouts / network), live{' '}
                  <code style={{ fontSize: 12 }}>WebSocket</code> faults, React crashes, and a short offline queue flushed after sign-in.{' '}
                  Download a <strong style={{ color: 'var(--text-primary)' }}>CSV or JSON audit report</strong> anytime. Operational AI below reads analytics + ANPR for prioritized insights.
                </p>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, maxWidth: 620, lineHeight: 1.55 }}>
                  Tip: entries are stored as written (not rewritten after the fact). If the list is empty right after deploy, wait ~45s for the first snapshot or use “Run snapshot now”.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={refreshAll} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RefreshCw size={14} /> Refresh data
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={snapshotMutation.isPending}
                onClick={() => snapshotMutation.mutate()}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Sparkles size={14} /> Run snapshot now
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setErrorLogPage(1);
                  setErrorLogsOpen(true);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <AlertTriangle size={14} /> System error logs
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setIncidentPath(`${window.location.pathname}${window.location.search || ''}`);
                  setIncidentOpen(true);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Bug size={14} /> Report system error
              </button>
              <select
                className="input"
                value={reportDays}
                onChange={e => setReportDays(Number(e.target.value))}
                style={{ padding: '8px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, width: 'auto' }}
              >
                {[7, 14, 30, 90].map(d => (
                  <option key={d} value={d}>Report: last {d}d</option>
                ))}
              </select>
              <button type="button" className="btn btn-secondary" onClick={() => downloadReport('csv')} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Download size={14} /> CSV report
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => downloadReport('json')} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileJson size={14} /> JSON report
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
            {[
              { to: '/analytics', label: 'Analytics', icon: BarChart3 },
              { to: '/visionflow', label: 'ANPR & cameras', icon: ScanLine },
              { to: '/visits', label: 'Visits', icon: Activity },
              { to: '/services', label: 'Services', icon: Wrench },
              { to: '/vehicles', label: 'Fleet', icon: Car },
            ].map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', borderRadius: 11,
                  background: 'var(--bg-surface)', border: '1px solid var(--border-light)',
                  color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, textDecoration: 'none',
                }}
              >
                <Icon size={14} color="#a78bfa" /> {label}
                <ArrowRight size={14} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))',
        gap: 12,
        marginBottom: 22,
      }}>
        {[
          {
            label: 'Timeline events',
            value: filtered.length,
            sub: page > 1 ? `Page ${page}` : 'This page',
            icon: Shield,
            accent: '#a78bfa',
          },
          {
            label: 'ANPR linkage',
            value: linkPct != null ? `${linkPct}%` : '—',
            sub: totalSynced ? `${linked}/${totalSynced} detections` : 'No reads yet',
            icon: Camera,
            accent: '#22d3ee',
          },
          {
            label: 'Pending linkage',
            value: dashboard?.anpr_pending_visits ?? '—',
            sub: 'Camera → visit',
            icon: ScanLine,
            accent: 'var(--text-warning)',
          },
          {
            label: `Avg dwell (${INSIGHT_DAYS}d)`,
            value: stats?.avg_duration_minutes != null ? `${Math.round(Number(stats.avg_duration_minutes))}m` : '—',
            sub: 'Visit duration',
            icon: Clock,
            accent: 'var(--text-warning)',
          },
          {
            label: 'Insight window',
            value: `${INSIGHT_DAYS}d`,
            sub: 'AI signals period',
            icon: Sparkles,
            accent: '#34d399',
          },
        ].map(({ label, value, sub, icon: Icon, accent }) => (
          <div
            key={label}
            className="card"
            style={{
              padding: '14px 16px',
              border: '1px solid var(--border-light)',
              borderRadius: 14,
              transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = `0 12px 28px rgba(0,0,0,0.18), 0 0 0 1px ${accent}22`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = '';
              e.currentTarget.style.boxShadow = '';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 11,
                background: `${accent}18`,
                border: `1px solid ${accent}40`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={17} color={accent} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{value}</div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Operational AI */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Lightbulb size={20} color="var(--text-warning)" />
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              Operational intelligence
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              Rule-based audit AI — revenue mix, service duration drift, fleet dwell, completion, and VisionFlow health ({INSIGHT_DAYS}-day window + live counters).
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
          gap: 14,
        }}>
          {operationalInsights.map((ins, idx) => {
            const st = INSIGHT_STYLE[ins.tone];
            const Icon = st.icon;
            return (
              <div
                key={ins.id}
                style={{
                  position: 'relative',
                  padding: '18px 20px',
                  borderRadius: 16,
                  border: `1px solid ${st.border}`,
                  background: `linear-gradient(155deg, var(--bg-surface), ${st.glow})`,
                  animation: `audit-slide 0.35s ease ${Math.min(idx, 8) * 40}ms both`,
                  overflow: 'hidden',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 12,
                    background: 'var(--bg-elevated)',
                    border: `1px solid ${st.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <Icon size={18} color="var(--text-accent)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
                      {ins.tone === 'revenue' ? 'Revenue' : ins.tone === 'throughput' ? 'Throughput' : ins.tone === 'vision' ? 'Vision / ANPR' : ins.tone === 'risk' ? 'Risk' : 'Operations'}
                      {ins.metric && <span style={{ marginLeft: 8, color: 'var(--text-accent)' }}>· {ins.metric}</span>}
                    </div>
                    <div style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.35 }}>
                      {ins.title}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                      {ins.detail}
                    </div>
                    {ins.action && (
                      <Link
                        to={ins.action.to}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 12,
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: 'var(--text-accent)',
                          textDecoration: 'none',
                        }}
                      >
                        {ins.action.label} <ArrowRight size={14} />
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick snapshot tables */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
        gap: 16,
        marginBottom: 22,
      }}>
        <div className="card" style={{ borderRadius: 16, border: '1px solid var(--border-light)', overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Clock size={18} color="var(--text-warning)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Services · duration watchlist</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Largest gap vs estimate (min. 2 jobs)</div>
            </div>
          </div>
          <div style={{ padding: 12 }}>
            {!(serviceDuration || []).length ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>No duration telemetry yet</div>
            ) : (
              [...(serviceDuration || [])]
                .map(s => ({
                  s,
                  est: Number(s.estimated_duration) || 0,
                  act: Number(s.avg_actual_minutes ?? s.avg_actual_duration) || 0,
                  gap: (Number(s.avg_actual_minutes ?? s.avg_actual_duration) || 0) - (Number(s.estimated_duration) || 0),
                }))
                .filter(x => x.est > 0 && (x.s.count ?? 0) >= 2)
                .sort((a, b) => b.gap - a.gap)
                .slice(0, 5)
                .map(({ s, est, act, gap }) => (
                  <div
                    key={s.service_name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-light)',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ minWidth: 0, paddingRight: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.service_name}>
                        {s.service_name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.count} jobs</div>
                    </div>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: gap > 0 ? '#fb923c' : 'var(--text-success)' }}>
                        {Math.round(act)}m vs {est}m
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{gap > 0 ? `+${Math.round(gap)}m` : `${Math.round(gap)}m`}</div>
                    </div>
                  </div>
                ))
            )}
          </div>
          <div style={{ padding: '0 12px 14px' }}>
            <Link to="/analytics?tab=services" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}>
              Open services analytics <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <div className="card" style={{ borderRadius: 16, border: '1px solid var(--border-light)', overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Layers size={18} color="var(--text-accent)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Fleet · dwell by type</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Highest average visit duration</div>
            </div>
          </div>
          <div style={{ padding: 12 }}>
            {!(vehicleTypes || []).length ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>No vehicle-type breakdown</div>
            ) : (
              [...(vehicleTypes || [])]
                .sort((a, b) => (Number(b.avg_duration_minutes) || 0) - (Number(a.avg_duration_minutes) || 0))
                .slice(0, 5)
                .map(vt => (
                  <div
                    key={vt.vehicle_type}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-light)',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13, textTransform: 'capitalize', color: 'var(--text-primary)' }}>
                      {vt.vehicle_type}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-accent)' }}>{Math.round(vt.avg_duration_minutes ?? 0)}m</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{vt.count} visits</div>
                    </div>
                  </div>
                ))
            )}
          </div>
          <div style={{ padding: '0 12px 14px' }}>
            <Link to="/analytics" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}>
              Full analytics <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <div className="card" style={{ borderRadius: 16, border: '1px solid var(--border-light)', overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Gauge size={18} color="#34d399" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Vision &amp; plates</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Operational checklist</div>
            </div>
          </div>
          <ul style={{ margin: 0, padding: '14px 18px 18px 32px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <li>
              <strong style={{ color: 'var(--text-primary)' }}>ROI &amp; height:</strong> frame the plate lane with minimal sky — reduces glare OCR errors.
            </li>
            <li>
              <strong style={{ color: 'var(--text-primary)' }}>Shutter &amp; blur:</strong> if duplicate reads are high, shorten tracking overlap or narrow ROI before decode.
            </li>
            <li>
              <strong style={{ color: 'var(--text-primary)' }}>Linkage:</strong> register recurring plates so detections attach automatically — improves audit trails.
            </li>
            <li>
              <strong style={{ color: 'var(--text-primary)' }}>Bay pairing:</strong> align camera IDs with bay numbers in VisionFlow for faster manual reconciliation.
            </li>
          </ul>
          <div style={{ padding: '0 12px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/visionflow" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', flex: 1, justifyContent: 'center', minWidth: 120 }}>
              Open analyzer
            </Link>
            <Link to="/visionflow/history" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', flex: 1, justifyContent: 'center', minWidth: 120 }}>
              History
            </Link>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={20} color="#a78bfa" />
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>Activity timeline</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 520 }}>
              Who did what and when — plus scheduled <strong style={{ color: 'var(--text-secondary)' }}>periodic_audit</strong> rows from the server. Older pages use pagination.
            </div>
          </div>
        </div>
        <div className="info-chip">
          <Eye size={12} /> {filtered.length} on this page · {LOG_LIMIT}/page
        </div>
      </div>

      <div className="card" style={{ borderRadius: 16, border: '1px solid var(--border-light)', overflow: 'hidden', marginBottom: 16 }}>
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-base)',
          alignItems: 'center',
        }}>
          <div className="search-wrap" style={{ flex: '1 1 200px', minWidth: 0 }}>
            <Search size={14} />
            <input
              className="input search-input"
              placeholder="Search user, action, entity, description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input"
            style={{ width: 'auto', minWidth: 140 }}
            value={action}
            onChange={e => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All actions</option>
            {actions.map(a => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 'auto', minWidth: 140 }}
            value={entity}
            onChange={e => {
              setEntity(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All entities</option>
            {entities.map(en => (
              <option key={en} value={en}>
                {en}
              </option>
            ))}
          </select>
          {(search || action || entity) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setAction(''); setEntity(''); setPage(1); }}>
              <X size={12} /> Reset
            </button>
          )}
        </div>

        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
            <div className="spinner" style={{ width: 36, height: 36 }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 48 }}>
            <Shield size={40} />
            <h3>No audit events on this page</h3>
            <p style={{ maxWidth: 420, margin: '0 auto' }}>
              Clear filters, sign in again to generate a login row, or press <strong>Run snapshot now</strong> above.
              The backend also records snapshots automatically (first run shortly after server start, then on a fixed interval — see <code style={{ fontSize: 12 }}>AUDIT_PERIODIC_INTERVAL_SECONDS</code> in server config).
            </p>
          </div>
        ) : (
          <div style={{ padding: '8px 0 12px' }}>
            {filtered.map((log: AuditLog, i: number) => {
              const actionCfg = ACTION_CFG[log.action?.toLowerCase() || ''] || ACTION_CFG.view;
              const entityColor = ENTITY_COLORS[log.entity_type?.toLowerCase() || ''] || '#9ca3af';
              const initials =
                log.user?.full_name?.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase() ||
                log.user?.username?.slice(0, 2).toUpperCase() ||
                '?';

              return (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    gap: 0,
                    alignItems: 'stretch',
                    padding: '0 12px 0 8px',
                    animation: `audit-slide 0.25s ease ${Math.min(i, 12) * 25}ms both`,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 44, flexShrink: 0, paddingTop: 16 }}>
                    <div
                      className={actionCfg.badgeClass}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        zIndex: 1,
                        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                      }}
                    >
                      {actionCfg.icon}
                    </div>
                    {i < filtered.length - 1 && (
                      <div style={{ flex: 1, width: 2, background: 'linear-gradient(180deg, var(--border-light), transparent)', marginTop: 6, borderRadius: 99 }} />
                    )}
                  </div>

                  <div
                    style={{
                      flex: 1,
                      padding: '14px 14px 18px 10px',
                      borderBottom: i < filtered.length - 1 ? '1px solid var(--border-light)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 8,
                            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 10,
                            fontWeight: 800,
                            color: 'white',
                            flexShrink: 0,
                          }}
                        >
                          {initials}
                        </div>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {log.user?.full_name || log.user?.username || 'System'}
                        </span>
                        <span className={actionCfg.badgeClass} style={{ padding: '3px 10px', fontSize: 11, textTransform: 'capitalize', fontWeight: 700 }}>
                          {log.action}
                        </span>
                        {log.entity_type && (
                          <span
                            style={{
                              padding: '3px 10px',
                              borderRadius: 99,
                              fontSize: 11,
                              fontWeight: 700,
                              background: `${entityColor}15`,
                              color: entityColor,
                              border: `1px solid ${entityColor}35`,
                              textTransform: 'capitalize',
                            }}
                          >
                            {log.entity_type}
                            {log.entity_id != null && ` #${log.entity_id}`}
                          </span>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          {log.created_at ? fmtQatar(log.created_at, 'dmyHm') : '—'}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          {log.created_at ? formatDistanceToNow(new Date(log.created_at), { addSuffix: true }) : ''}
                        </div>
                      </div>
                    </div>

                    {log.description && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 8px' }}>
                        {log.description}
                      </p>
                    )}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                      {log.ip_address && (
                        <span style={{ fontFamily: 'monospace' }}>IP {log.ip_address}</span>
                      )}
                      {log.user_agent && (
                        <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.user_agent}>
                          {log.user_agent.slice(0, 80)}{log.user_agent.length > 80 ? '…' : ''}
                        </span>
                      )}
                    </div>

                    {log.old_values && typeof log.old_values === 'object' && (
                      <JsonPeek label="Previous values" data={log.old_values as Record<string, unknown>} />
                    )}
                    {log.new_values && typeof log.new_values === 'object' && (
                      <JsonPeek
                        label={
                          log.action === 'system_error_report'
                            ? 'Error report details'
                            : log.action === 'client_auto_error'
                              ? 'Captured error details'
                              : 'New values'
                        }
                        data={log.new_values as Record<string, unknown>}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showPagination && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginTop: 8, marginBottom: 32, gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
            ← Newer
          </button>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', padding: '0 12px' }}>
            Page {page}
          </span>
          <button type="button" className="btn btn-secondary" disabled={!hasNextPage} onClick={() => setPage(p => p + 1)}>
            Older →
          </button>
        </div>
      )}

      {errorLogsOpen && (
        <div className="modal-backdrop" onClick={() => setErrorLogsOpen(false)}>
          <div
            className="modal-box"
            style={{ maxWidth: 720, width: 'min(96vw, 720px)', maxHeight: 'min(90vh, 820px)', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AlertTriangle size={20} color="#f87171" />
                <div>
                  <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>System error logs</h2>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, fontWeight: 600 }}>
                    Auto-captured client errors and manual reports · newest first
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={errorLogsFetching}
                  onClick={() => refetchErrorLogs()}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <RefreshCw size={14} style={errorLogsFetching ? { animation: 'audit-pulse 0.9s ease infinite' } : undefined} /> Refresh
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setErrorLogsOpen(false)}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="modal-body" style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 8 }}>
              {errorLogsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                  <div className="spinner" style={{ width: 36, height: 36 }} />
                </div>
              ) : errorLogs.length === 0 ? (
                <div className="empty-state" style={{ padding: 36 }}>
                  <Shield size={36} />
                  <h3 style={{ fontSize: 15 }}>No recorded errors yet</h3>
                  <p style={{ maxWidth: 440, margin: '0 auto', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    While signed in, the app records API failures, WebSocket faults, CSP violations, lazy-route chunk errors, console noise (within limits),
                    and other runtime signals — each stored as <code style={{ fontSize: 12 }}>client_auto_error</code> with a <code style={{ fontSize: 12 }}>kind</code> field.
                    Staff can still file <code style={{ fontSize: 12 }}>system_error_report</code> from “Report system error”.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {errorLogs.map((log: AuditLog) => {
                    const actionCfg = ACTION_CFG[log.action?.toLowerCase() || ''] || ACTION_CFG.view;
                    const nv = log.new_values && typeof log.new_values === 'object' ? (log.new_values as Record<string, unknown>) : null;
                    const preview =
                      (typeof nv?.message === 'string' && nv.message) ||
                      log.description ||
                      (typeof nv?.details === 'string' && nv.details.slice(0, 400)) ||
                      '';
                    return (
                      <div
                        key={log.id}
                        style={{
                          padding: '12px 14px',
                          borderRadius: 12,
                          border: '1px solid var(--border-light)',
                          background: 'var(--bg-base)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span className={actionCfg.badgeClass} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                              {log.action}
                            </span>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                              {log.user?.full_name || log.user?.username || '—'}
                            </span>
                            {typeof nv?.kind === 'string' && (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{nv.kind}</span>
                            )}
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                            {log.created_at ? fmtQatar(log.created_at, 'dmyHm') : '—'}
                          </span>
                        </div>
                        {preview && (
                          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                            {String(preview).slice(0, 500)}
                            {String(preview).length > 500 ? '…' : ''}
                          </p>
                        )}
                        {nv && (
                          <JsonPeek label={log.action === 'system_error_report' ? 'Error report details' : 'Captured error details'} data={nv} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
                Page {errorLogPage}
                {errorLogs.length > 0 ? ` · ${errorLogs.length} row${errorLogs.length === 1 ? '' : 's'}` : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={errorLogPage <= 1 || errorLogsFetching}
                  onClick={() => setErrorLogPage(p => Math.max(1, p - 1))}
                >
                  Newer
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!errorLogsHasNext || errorLogsFetching}
                  onClick={() => setErrorLogPage(p => p + 1)}
                >
                  Older
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setErrorLogsOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {incidentOpen && (
        <div className="modal-backdrop" onClick={() => !incidentMutation.isPending && setIncidentOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Bug size={20} color="#fb923c" />
                <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Report system error</h2>
              </div>
              <button type="button" className="btn btn-ghost btn-icon" disabled={incidentMutation.isPending} onClick={() => setIncidentOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, lineHeight: 1.55 }}>
                This creates an audit entry (<strong>system_error_report</strong>) with your account, time, page path, and full notes so developers can trace and fix the issue.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label className="label">Short summary</label>
                  <input
                    className="input"
                    placeholder="e.g. Checkout button shows 500 after saving signature"
                    value={incidentSummary}
                    onChange={e => setIncidentSummary(e.target.value)}
                    maxLength={240}
                  />
                </div>
                <div>
                  <label className="label">Details (steps, messages, what you expected)</label>
                  <textarea
                    className="input"
                    style={{ minHeight: 140, resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="1. Opened visit…&#10;2. Clicked…&#10;Error text: …"
                    value={incidentDetails}
                    onChange={e => setIncidentDetails(e.target.value)}
                    maxLength={32000}
                  />
                </div>
                <div>
                  <label className="label">Page / URL path (optional)</label>
                  <input className="input" value={incidentPath} onChange={e => setIncidentPath(e.target.value)} placeholder="/visits/12" />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" disabled={incidentMutation.isPending} onClick={() => setIncidentOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={
                  incidentMutation.isPending ||
                  incidentSummary.trim().length < 4 ||
                  incidentDetails.trim().length < 12
                }
                onClick={() => incidentMutation.mutate()}
              >
                {incidentMutation.isPending ? 'Saving…' : 'Save to audit log'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
