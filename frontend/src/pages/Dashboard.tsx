import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Car, CheckCircle, DollarSign, Activity,
  ArrowRight, RefreshCw,
  AlertTriangle, Target, Timer,
  ClipboardList,
  ExternalLink, LogOut, PlayCircle,
} from 'lucide-react';
import { analyticsApi, visitsApi } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { OpsQuickNav } from '../components/ops/OpsQuickNav';
import { AnprDashboardWidget } from '../components/anpr/AnprDashboardWidget';
import { DashboardTodayOps } from '../components/dashboard/DashboardTodayOps';
import { LiveCameraEmbedPanel } from './visionflow/VisionFlowMultiCam';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { Visit } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { fmtQatarClock, fmtQatarDateLong, fmtQatarEntryHm, qatarHour } from '../lib/qatarTime';

function useLiveMinutes(entryTime: string) {
  const [mins, setMins] = useState(() =>
    Math.floor((Date.now() - new Date(entryTime).getTime()) / 60000)
  );
  useEffect(() => {
    const t = setInterval(() => {
      setMins(Math.floor((Date.now() - new Date(entryTime).getTime()) / 60000));
    }, 30000);
    return () => clearInterval(t);
  }, [entryTime]);
  return mins;
}

function fmtDur(m: number) {
  if (!m || m < 0) return '0m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  waiting:    { label: 'Waiting',    color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)' },
  in_service: { label: 'In Service', color: 'var(--text-accent)', bg: 'rgba(147,197,253,0.12)' },
  on_hold:    { label: 'On Hold',    color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
  completed:  { label: 'Completed',  color: 'var(--text-success)', bg: 'rgba(110,231,183,0.12)' },
  cancelled:  { label: 'Cancelled',  color: 'var(--text-danger)', bg: 'rgba(252,165,165,0.12)' },
};

const thStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 9,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border-light)',
  background: 'var(--bg-elevated)',
};

const tdStyle: React.CSSProperties = {
  padding: '9px 12px',
  fontSize: 12.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-light)',
  verticalAlign: 'middle',
};

/* ── Enhanced Bay Map (legacy grid — use BayBoard in main layout) ── */
const BayMap: React.FC<{ activeBays: number[]; total: number }> = ({ activeBays, total }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(total, 5)}, 1fr)`, gap: 6 }}>
    {Array.from({ length: total }, (_, i) => i + 1).map(bay => {
      const active = activeBays.includes(bay);
      return (
        <div key={bay} style={{
          background: active ? 'rgba(59,130,246,0.08)' : 'var(--bg-base)',
          border: `1px solid ${active ? 'rgba(59,130,246,0.35)' : 'var(--border-light)'}`,
          borderRadius: 8, padding: '8px 4px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 9, color: active ? 'var(--text-accent)' : 'var(--text-muted)', fontWeight: 800, letterSpacing: '0.04em' }}>
            {bay}
          </div>
          <div style={{
            fontSize: 8, marginTop: 2, fontWeight: 700,
            color: active ? '#059669' : 'var(--text-muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
          }}>
            <span style={{
              width: 4, height: 4, borderRadius: '50%',
              background: active ? '#10b981' : 'var(--border)',
            }} />
            {active ? 'On' : 'Free'}
          </div>
        </div>
      );
    })}
  </div>
);

/* ── Live Visit Row ─────────────────────────── */
const LiveRow: React.FC<{
  visit: Visit;
  rank: number;
  onStart?: (id: number) => void;
  onCheckout?: (id: number) => void;
  busy?: boolean;
}> = ({ visit, rank, onStart, onCheckout, busy }) => {
  const mins = useLiveMinutes(visit.entry_time);
  const cfg = STATUS_CONFIG[visit.status] || STATUS_CONFIG.waiting;
  const isLate = mins > 120;
  const isWarning = mins > 60 && !isLate;

  return (
    <tr
      style={{ transition: 'background 0.12s' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={tdStyle}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{rank}</span>
      </td>
      <td style={tdStyle}>
        <Link to={`/visits/${visit.id}`} style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 13,
          color: 'var(--text-accent)', textDecoration: 'none',
          background: 'rgba(59,130,246,0.08)', padding: '4px 10px', borderRadius: 8,
          letterSpacing: '0.04em',
        }}>
          {visit.vehicle?.plate_number}
        </Link>
      </td>
      <td style={{ ...tdStyle, minWidth: 140 }}>
        {visit.vehicle?.make
          ? <><span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{visit.vehicle.make}</span> {visit.vehicle.model || ''}</>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
        {visit.vehicle?.color && (
          <span style={{
            fontSize: 10, color: 'var(--text-muted)', marginLeft: 8,
            background: 'var(--bg-base)', padding: '2px 7px', borderRadius: 99, textTransform: 'capitalize',
          }}>
            {visit.vehicle.color}
          </span>
        )}
      </td>
      <td style={tdStyle}>
        {visit.assigned_bay
          ? <span className="badge badge-blue">Bay {visit.assigned_bay}</span>
          : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
      </td>
      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {fmtQatarEntryHm(visit.entry_time)}
      </td>
      <td style={tdStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{
            fontWeight: 800, fontSize: 14,
            color: isLate ? '#dc2626' : isWarning ? '#d97706' : '#059669',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {fmtDur(mins)}
          </span>
          {(isLate || isWarning) && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 10, fontWeight: 700,
              color: isLate ? '#dc2626' : '#d97706',
            }}>
              <AlertTriangle size={10} />
              {isLate ? 'Overdue' : 'Long wait'}
            </span>
          )}
        </div>
      </td>
      <td style={tdStyle}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', borderRadius: 99,
          background: cfg.bg, color: cfg.color,
          fontSize: 11, fontWeight: 700,
        }}>
          {visit.status === 'in_service' && (
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, animation: 'pulse 1.5s infinite' }} />
          )}
          {cfg.label}
        </span>
      </td>
      <td style={{ ...tdStyle, maxWidth: 180 }}>
        {visit.service_items?.length > 0
          ? <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {visit.service_items.slice(0, 2).map((s, i) => (
                <span key={i} style={{
                  background: 'var(--bg-base)', padding: '2px 8px', borderRadius: 99,
                  fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
                  border: '1px solid var(--border-light)',
                }}>
                  {s.service?.name}
                </span>
              ))}
              {visit.service_items.length > 2 && (
                <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>+{visit.service_items.length - 2}</span>
              )}
            </span>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 12 }}>
        <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {visit.status === 'waiting' && onStart && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
              style={{ fontSize: 10, padding: '3px 8px' }}
              onClick={() => onStart(visit.id)}>
              <PlayCircle size={11} /> Start
            </button>
          )}
          {['waiting', 'in_service', 'on_hold'].includes(visit.status) && onCheckout && (
            <button type="button" className="btn btn-success btn-sm" disabled={busy}
              style={{ fontSize: 10, padding: '3px 8px' }}
              onClick={() => onCheckout(visit.id)}>
              <LogOut size={11} /> Out
            </button>
          )}
          <Link
            to={`/visits/${visit.id}`}
            className="btn btn-ghost btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px', textDecoration: 'none' }}
          >
            Open
          </Link>
        </div>
      </td>
    </tr>
  );
};

/* ── Chart Tooltip ─────────────────────────── */
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '10px 14px', fontSize: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
    }}>
      <p style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>{label}:00</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color || 'var(--text-accent)', fontWeight: 700, margin: '2px 0' }}>
          {p.value} {p.dataKey === 'anpr' ? 'ANPR detections' : 'visits'}
        </p>
      ))}
    </div>
  );
};

/* ── Sparkline mini chart ─────────────────── */
const MiniSparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (!data?.length) return null;
  const max = Math.max(...data) || 1;
  const w = 56, h = 22;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */
export const Dashboard: React.FC = () => {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [queueTab, setQueueTab] = useState<'all' | 'waiting' | 'in_service' | 'on_hold'>('all');

  const startMutation = useMutation({
    mutationFn: (id: number) => visitsApi.update(id, { status: 'in_service' }),
    onSuccess: () => {
      toast.success('Marked in service');
      qc.invalidateQueries({ queryKey: ['active-visits'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['analytics-today-ops'] });
    },
    onError: () => toast.error('Could not update status'),
  });

  const checkoutMutation = useMutation({
    mutationFn: (id: number) => visitsApi.checkout(id),
    onSuccess: () => {
      toast.success('Checked out');
      qc.invalidateQueries({ queryKey: ['active-visits'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['analytics-today-ops'] });
      qc.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: () => toast.error('Checkout failed'),
  });

  const opsBusy = startMutation.isPending || checkoutMutation.isPending;

  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => analyticsApi.dashboard().then(r => r.data),
    refetchInterval: 30000,
  });

  const { data: activeVisits } = useQuery({
    queryKey: ['active-visits'],
    queryFn: () => visitsApi.active().then(r => r.data),
    refetchInterval: 15000,
  });

  const { data: hourlyData } = useQuery({
    queryKey: ['hourly-stats'],
    queryFn: () => analyticsApi.hourly().then(r => r.data),
    refetchInterval: 300000,
  });

  useWebSocket((msg) => {
    if (['visit_update', 'new_entry'].includes(msg.type)) {
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['active-visits'] });
      qc.invalidateQueries({ queryKey: ['analytics-today-ops'] });
      setLastRefresh(new Date());
    }
  });

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    qc.invalidateQueries({ queryKey: ['active-visits'] });
    qc.invalidateQueries({ queryKey: ['analytics-today-ops'] });
    setLastRefresh(new Date());
  };

  const activeBayNums = Object.keys(stats?.bay_utilization || {}).map(Number);
  const hour = qatarHour();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const totalToday = stats?.total_cars_today ?? 0;
  const completedToday = stats?.cars_completed_today ?? 0;
  const completionRate = totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0;
  const avgTime = Math.round(stats?.avg_service_time_minutes ?? 0);

  // Build sparkline from hourly data (last 8 hours)
  const sparkData = (hourlyData || []).slice(-8).map((h: any) => h.count || 0);

  const anprToday    = stats?.anpr_detected_today ?? 0;
  const anprPending  = stats?.anpr_pending_visits ?? 0;
  const anprAvgSpeed = stats?.anpr_avg_speed_today ?? null;

  // Combined "Cars Today" = visits + ANPR detections without a visit
  const combinedCarsToday = totalToday + anprPending;

  const kpis = [
    {
      label: 'Cars Today',
      value: combinedCarsToday,
      icon: Car, color: 'var(--text-accent)', bg: 'rgba(59,130,246,0.12)',
      sub: totalToday > 0 || anprToday > 0
        ? `${totalToday} visit${totalToday !== 1 ? 's' : ''}${anprPending > 0 ? ` · ${anprPending} ANPR pending` : ''}`
        : 'Total entries today',
      spark: sparkData, sparkColor: 'var(--text-accent)',
      trend: null,
      badge: anprToday > 0 ? { label: `+${anprToday} ANPR`, color: '#06b6d4' } : null,
    },
    {
      label: 'In Shop Now', value: stats?.cars_in_shop ?? 0,
      icon: Activity, color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)',
      sub: 'Currently in service', spark: null, sparkColor: 'var(--text-warning)',
      trend: null, badge: null,
    },
    {
      label: 'Completed', value: completedToday,
      icon: CheckCircle, color: 'var(--text-success)', bg: 'rgba(110,231,183,0.12)',
      sub: `${completionRate}% completion rate`, spark: null, sparkColor: 'var(--text-success)',
      trend: completionRate, badge: null,
    },
    {
      label: 'Avg Service Time', value: fmtDur(avgTime),
      icon: Timer, color: '#f472b6', bg: 'rgba(244,114,182,0.12)',
      sub: 'Per visit average', spark: null, sparkColor: '#f472b6',
      trend: null, badge: null,
    },
    {
      label: 'Revenue Today', value: `QAR ${(stats?.total_revenue_today ?? 0).toLocaleString()}`,
      icon: DollarSign, color: 'var(--text-purple)', bg: 'rgba(196,181,253,0.12)',
      sub: "Today's earnings", spark: null, sparkColor: 'var(--text-purple)',
      trend: null, badge: null,
    },
    {
      label: 'Bay Utilization',
      value: `${stats?.total_bays ? Math.round((activeBayNums.length / stats.total_bays) * 100) : 0}%`,
      icon: Target, color: '#34d399', bg: 'rgba(52,211,153,0.12)',
      sub: `${activeBayNums.length} of ${stats?.total_bays ?? 5} bays occupied`,
      spark: null, sparkColor: '#34d399', trend: null,
      badge: anprAvgSpeed ? { label: `${anprAvgSpeed} km/h avg`, color: '#f59e0b' } : null,
    },
  ];

  const lateVisits = (activeVisits || []).filter((v: any) => {
    const mins = Math.floor((Date.now() - new Date(v.entry_time).getTime()) / 60000);
    return mins > 90 && ['waiting', 'in_service', 'on_hold'].includes(v.status);
  });

  const queueVisits = useMemo(() => {
    let list = [...((activeVisits as Visit[]) || [])];
    if (queueTab !== 'all') list = list.filter(v => v.status === queueTab);
    return list.sort((a, b) => {
      const da = Date.now() - new Date(a.entry_time).getTime();
      const db = Date.now() - new Date(b.entry_time).getTime();
      return db - da;
    });
  }, [activeVisits, queueTab]);

  const queueCounts = useMemo(() => {
    const list = (activeVisits as Visit[]) || [];
    return {
      all: list.length,
      waiting: list.filter(v => v.status === 'waiting').length,
      in_service: list.filter(v => v.status === 'in_service').length,
      on_hold: list.filter(v => v.status === 'on_hold').length,
    };
  }, [activeVisits]);

  return (
    <div className="animate-fade-in">
      <style>{`
        @keyframes shimmer { 0%,100%{opacity:0} 50%{opacity:1} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes pingAnim { 0%{transform:scale(1);opacity:0.8} 100%{transform:scale(2.4);opacity:0} }
        @keyframes slideDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* Late Alert Banner */}
      {lateVisits.length > 0 && (
        <div className="late-visits-bar" style={{
          padding: '8px 14px',
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.22)',
          borderRadius: 10, marginBottom: 12, fontSize: 12,
        }}>
          <AlertTriangle size={14} color="#dc2626" style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: '#dc2626' }}>
            {lateVisits.length} overdue (&gt;90m)
          </span>
          <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
            {lateVisits.slice(0, 5).map((v: any) => (
              <Link key={v.id} to={`/visits/${v.id}`} style={{
                padding: '1px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700,
                background: 'rgba(239,68,68,0.1)', color: '#dc2626', textDecoration: 'none',
              }}>
                {v.vehicle?.plate_number}
              </Link>
            ))}
          </div>
          <Link to="/visits" style={{ fontSize: 10, color: '#dc2626', textDecoration: 'none', flexShrink: 0 }}>
            All <ArrowRight size={10} />
          </Link>
        </div>
      )}

      <OpsQuickNav primaryAction={{ to: '/visits/new', label: 'Work order' }} />

      {/* Compact header */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 14, paddingBottom: 14,
        borderBottom: '1px solid var(--border-light)',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>
              Operations
            </h1>
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '3px 8px', borderRadius: 99,
              background: 'rgba(16,185,129,0.1)', color: '#059669', border: '1px solid rgba(16,185,129,0.22)',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', animation: 'pulse 2s ease infinite' }} />
              Live
            </span>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
            {greeting}, {user?.full_name?.split(' ')[0]} · {fmtQatarDateLong()} · Sync {fmtQatarClock(lastRefresh)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { to: '/visits', label: 'Visits' },
            { to: '/vehicles', label: 'Fleet' },
            { to: '/analytics', label: 'Analytics' },
          ].map(l => (
            <Link key={l.to} to={l.to} style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textDecoration: 'none',
              padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-surface)',
            }}>{l.label}</Link>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh} style={{ padding: '4px 10px' }}>
            <RefreshCw size={13} />
          </button>
          <Link to="/visits/new" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <ClipboardList size={13} /> Work order
          </Link>
        </div>
      </div>

      {/* Compact KPI strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
        gap: 8,
        marginBottom: 14,
      }}>
        {kpis.map(({ label, value, icon: Icon, color, bg, sub, spark, sparkColor, trend, badge }: any) => (
          <div
            key={label}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-light)',
              borderRadius: 10,
              padding: '10px 12px',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: bg, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon size={15} color={color} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                {value}
                {trend !== null && trend !== undefined && (
                  <span style={{
                    marginLeft: 6, fontSize: 10, fontWeight: 800,
                    color: (trend as number) >= 70 ? '#059669' : '#d97706',
                  }}>{trend}%</span>
                )}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginTop: 2 }}>{label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub}>
                {sub}
              </div>
              {badge && (
                <div style={{ marginTop: 4, fontSize: 9, fontWeight: 700, color: badge.color }}>{badge.label}</div>
              )}
            </div>
            {spark && spark.length > 1 && (
              <div style={{ flexShrink: 0, opacity: 0.85 }}><MiniSparkline data={spark} color={sparkColor} /></div>
            )}
          </div>
        ))}
      </div>

      {/* Active visits — priority ops table */}
      <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)', padding: 0, marginBottom: 14 }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
          background: 'var(--bg-elevated)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>Shop floor queue</span>
            {([
              ['all', 'All', queueCounts.all],
              ['waiting', 'Waiting', queueCounts.waiting],
              ['in_service', 'In service', queueCounts.in_service],
              ['on_hold', 'On hold', queueCounts.on_hold],
            ] as const).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                className={`ops-queue-tab${queueTab === key ? ' active' : ''}`}
                onClick={() => setQueueTab(key)}
              >
                {label}{n > 0 ? ` (${n})` : ''}
              </button>
            ))}
          </div>
          <Link to="/visits?view=floor" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', fontSize: 11, padding: '3px 8px' }}>
            Full floor view <ArrowRight size={11} />
          </Link>
        </div>

        {!queueVisits.length ? (
          <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>No vehicles in shop</p>
            <Link to="/visits/new" className="btn btn-primary btn-sm" style={{ marginTop: 12, textDecoration: 'none', display: 'inline-flex' }}>
              <ClipboardList size={12} /> Work order
            </Link>
          </div>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
              <thead>
                <tr>
                  {['#', 'Plate', 'Vehicle', 'Bay', 'Entry', 'Duration', 'Status', 'Services', ''].map(h => (
                    <th key={h || 'act'} style={{
                      ...thStyle,
                      textAlign: h === '' ? 'right' : 'left',
                      paddingLeft: h === '#' ? 12 : undefined,
                      paddingRight: h === '' ? 12 : undefined,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queueVisits.map((v, i) => (
                  <LiveRow
                    key={v.id}
                    visit={v}
                    rank={i + 1}
                    busy={opsBusy}
                    onStart={id => startMutation.mutate(id)}
                    onCheckout={id => checkoutMutation.mutate(id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Charts + bays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 10, marginBottom: 14 }}>
        {/* Hourly Traffic + live camera */}
        <div className="card dash-hourly-card" style={{ padding: '12px 14px', border: '1px solid var(--border-light)', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>Hourly traffic</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10, fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>
                <span><span style={{ color: 'var(--text-accent)' }}>—</span> Visits</span>
                <span><span style={{ color: '#06b6d4' }}>—</span> ANPR</span>
              </div>
              <Link to="/visionflow/multicam" className="btn btn-ghost btn-sm" style={{ fontSize: 10, padding: '2px 8px', textDecoration: 'none' }}>
                Camera wall <ExternalLink size={10} />
              </Link>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={hourlyData || []} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="grad-blue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="grad-cyan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(75,85,99,0.2)" vertical={false} />
              <XAxis dataKey="hour" tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                tickFormatter={h => `${h}:00`} axisLine={false} tickLine={false} interval={2} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="anpr" stroke="#06b6d4" strokeWidth={1.5} strokeDasharray="4 2"
                fill="url(#grad-cyan)" dot={false} activeDot={{ r: 4, fill: '#06b6d4', strokeWidth: 0 }} />
              <Area type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2.5}
                fill="url(#grad-blue)" dot={false} activeDot={{ r: 5, fill: 'var(--text-accent)', strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
          <div className="dash-hourly-live-cam">
            <LiveCameraEmbedPanel />
          </div>
        </div>

        {/* Today: revenue + service duration */}
        <DashboardTodayOps />
      </div>

      <AnprDashboardWidget />
    </div>
  );
};
