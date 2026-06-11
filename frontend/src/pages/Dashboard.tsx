import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Car, CheckCircle, DollarSign, Activity,
  ArrowRight, RefreshCw,
  AlertTriangle, Target, Timer,
  ScanLine, Link2, Plus, ClipboardList,
  ExternalLink,
} from 'lucide-react';
import { analyticsApi, visitsApi, anprApi } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
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

/* ── Enhanced Bay Map ─────────────────────────── */
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
const LiveRow: React.FC<{ visit: Visit; rank: number }> = ({ visit, rank }) => {
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
      <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 18 }}>
        <Link
          to={`/visits/${visit.id}`}
          className="btn btn-ghost btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px', textDecoration: 'none' }}
        >
          Open <ExternalLink size={11} />
        </Link>
      </td>
    </tr>
  );
};

/* ── ANPR live widget ───────────────────────── */
const AnprWidget: React.FC = () => {
  const { data: statsRes } = useQuery({ queryKey: ['anpr-stats'], queryFn: () => anprApi.stats(), refetchInterval: 30000 });
  const { data: recentRes } = useQuery({ queryKey: ['anpr-recent'], queryFn: () => anprApi.recent(8), refetchInterval: 20000 });
  const stats = statsRes?.data;
  const recent: any[] = recentRes?.data ?? [];

  if (!stats && !recent.length) return null;

  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 14, border: '1px solid var(--border-light)', padding: 0 }}>
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        background: 'var(--bg-elevated)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ScanLine size={14} color="#06b6d4" />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>ANPR detections</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Recent plate reads</div>
          </div>
        </div>
        <Link to="/visionflow" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', fontSize: 11, padding: '4px 10px' }}>
          Analyzer <ArrowRight size={11} />
        </Link>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="anpr-stats-row" style={{ borderBottom: '1px solid var(--border-light)' }}>
          {[
            { label: 'Today', value: stats.today_detections ?? 0, color: '#06b6d4' },
            { label: 'Plates', value: stats.today_unique_plates ?? 0, color: '#3b82f6' },
            { label: 'Week', value: stats.week_detections ?? 0, color: '#8b5cf6' },
            { label: 'Speed', value: stats.avg_speed_kmh ? `${stats.avg_speed_kmh}` : '—', color: '#d97706' },
            { label: 'Linked', value: stats.linked_to_vehicle ?? 0, color: '#059669' },
          ].map(s => (
            <div key={s.label} style={{ padding: '8px 0', textAlign: 'center', borderRight: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Recent rows */}
      {recent.length > 0 && (
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                {['Plate', 'Speed', 'Vehicle', 'Owner', 'Visits', 'Detected', ''].map(h => (
                  <th key={h || 'act'} style={{ ...thStyle, textAlign: h === '' ? 'right' : 'left', paddingRight: h === '' ? 18 : undefined }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 5).map((d: any, idx: number) => (
                <tr key={d.id} style={{ background: idx % 2 === 1 ? 'rgba(6,182,212,0.02)' : 'transparent' }}>
                  <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 13, color: 'var(--text-primary)', letterSpacing: '0.06em' }}>{d.plate}</td>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {d.speed_kmh != null ? <span style={{ color: '#d97706', fontWeight: 700 }}>{d.speed_kmh} km/h</span> : '—'}
                  </td>
                  <td style={tdStyle}>
                    {d.vehicle ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#059669', fontWeight: 600 }}>
                        <Link2 size={12} /> {[d.vehicle.make, d.vehicle.model].filter(Boolean).join(' ') || d.vehicle.plate_number}
                      </span>
                    ) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not registered</span>}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{d.vehicle?.owner_name || '—'}</td>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{d.vehicle?.total_visits ?? '—'}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{d.detected_at ? fmtQatarEntryHm(d.detected_at) : '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 18 }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {d.vehicle && (
                        <Link to={`/vehicles/${d.vehicle.id}`} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '4px 8px', textDecoration: 'none' }}>
                          <Car size={11} /> Profile
                        </Link>
                      )}
                      <Link to={`/visits/new?plate=${encodeURIComponent(d.plate)}`} className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '4px 8px', textDecoration: 'none' }}>
                        <Plus size={11} /> Visit
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recent.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No ANPR detections yet — start live analysis on{' '}
          <Link to="/visionflow" style={{ color: 'var(--blue)', textDecoration: 'none' }}>ANPR &amp; Speed</Link>
          {' '}or the{' '}
          <Link to="/visionflow/multicam" style={{ color: 'var(--blue)', textDecoration: 'none' }}>Camera wall</Link>.
        </div>
      )}
    </div>
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
      setLastRefresh(new Date());
    }
  });

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    qc.invalidateQueries({ queryKey: ['active-visits'] });
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>Active visits</span>
            {(activeVisits?.length ?? 0) > 0 && (
              <span style={{
                background: 'rgba(59,130,246,0.1)', color: 'var(--text-accent)',
                borderRadius: 99, padding: '1px 8px', fontSize: 10, fontWeight: 800,
              }}>{activeVisits?.length}</span>
            )}
          </div>
          <Link to="/visits" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', fontSize: 11, padding: '3px 8px' }}>
            All visits <ArrowRight size={11} />
          </Link>
        </div>

        {!activeVisits?.length ? (
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
                {(activeVisits as Visit[]).map((v, i) => (
                  <LiveRow key={v.id} visit={v} rank={i + 1} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Charts + bays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 10, marginBottom: 14 }}>
        {/* Hourly Traffic */}
        <div className="card" style={{ padding: '12px 14px', border: '1px solid var(--border-light)', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>Hourly traffic</div>
            <div style={{ display: 'flex', gap: 10, fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>
              <span><span style={{ color: 'var(--text-accent)' }}>—</span> Visits</span>
              <span><span style={{ color: '#06b6d4' }}>—</span> ANPR</span>
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
        </div>

        {/* Bay Status */}
        <div className="card" style={{ padding: '12px 14px', border: '1px solid var(--border-light)', borderRadius: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>
              Bays · {activeBayNums.length}/{stats?.total_bays ?? 5}
            </div>
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-accent)', fontVariantNumeric: 'tabular-nums' }}>
              {stats?.total_bays ? Math.round((activeBayNums.length / stats.total_bays) * 100) : 0}%
            </span>
          </div>
          <BayMap activeBays={activeBayNums} total={stats?.total_bays ?? 5} />
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
            <span>Avg time</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{fmtDur(avgTime)}</span>
          </div>
        </div>
      </div>

      <AnprWidget />
    </div>
  );
};
