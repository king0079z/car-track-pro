import React, { useState, useMemo, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Car, ArrowLeft, Clock, DollarSign, Wrench, User, Calendar,
  Edit, Plus, BarChart2, TrendingUp,
  Camera, Save, X,
  ClipboardCopy, Sparkles, Gauge, ArrowRight, LayoutDashboard, FileText,
  ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink, Layers, Filter, PenLine,
} from 'lucide-react';
import { vehiclesApi } from '../../services/api';
import { formatDistanceToNow } from 'date-fns';
import { fmtQatar } from '../../lib/qatarTime';
import toast from 'react-hot-toast';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

const STATUS_CFG: Record<string, { label: string }> = {
  waiting:    { label: 'Waiting' },
  in_service: { label: 'In Service' },
  on_hold:    { label: 'On Hold' },
  completed:  { label: 'Completed' },
  cancelled:  { label: 'Cancelled' },
};

const CAT_COLORS: Record<string, string> = {
  wash: 'var(--text-accent)', detailing: 'var(--text-purple)', polish: '#f9a8d4',
  repair: 'var(--text-danger)', maintenance: 'var(--text-warning)', inspection: 'var(--text-cyan)', other: '#9ca3af',
};

function fmtDur(m: number | null | undefined) {
  if (!m) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

const COLOR_DOTS: Record<string, string> = {
  white: '#f9fafb', black: '#111827', silver: '#9ca3af', gray: '#6b7280',
  blue: '#3b82f6', red: '#ef4444', green: '#10b981', yellow: '#eab308',
  orange: '#f97316', gold: '#d97706', beige: '#d6bcac', maroon: '#7f1d1d',
  navy: '#1e3a5f', pink: '#ec4899', purple: '#8b5cf6',
};

type VisitSortKey = 'date' | 'duration' | 'revenue' | 'status';
type VisitSortDir = 'asc' | 'desc';
type VisitFilter = 'all' | 'active' | 'completed';

const thStyle: React.CSSProperties = {
  padding: '11px 14px',
  fontSize: 10,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  color: 'var(--text-muted)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border-light)',
  background: 'var(--bg-elevated)',
  userSelect: 'none',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 13,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-light)',
  verticalAlign: 'middle',
};

const SortIcon: React.FC<{ active: boolean; dir: VisitSortDir }> = ({ active, dir }) => {
  if (!active) return <ArrowUpDown size={11} style={{ opacity: 0.35 }} />;
  return dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
};

const VisitServicesPanel: React.FC<{ visit: any }> = ({ visit }) => (
  <div style={{
    background: 'linear-gradient(180deg, rgba(59,130,246,0.04) 0%, var(--bg-base) 100%)',
    borderTop: '1px solid var(--border-light)',
    padding: '16px 18px 18px 62px',
  }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14, fontSize: 12, color: 'var(--text-secondary)' }}>
      {visit.customer_name && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><User size={12} /> {visit.customer_name}</span>
      )}
      {visit.created_by && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Camera size={12} /> {visit.created_by}</span>
      )}
      {visit.exit_time && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock size={12} /> Exit {fmtQatar(visit.exit_time, 'hm')}</span>
      )}
      <span className={`status-pill ${visit.payment_status === 'paid' ? 'pay-paid' : 'pay-pending'}`} style={{ fontSize: 10, padding: '2px 8px' }}>
        {visit.payment_status}
      </span>
    </div>
    {visit.services?.length > 0 ? (
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid var(--border-light)', background: 'var(--bg-surface)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              {['Service', 'Category', 'Staff', 'Duration', 'Price', 'Status'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visit.services.map((svc: any, idx: number) => {
              const catColor = CAT_COLORS[svc.service_category] || '#9ca3af';
              return (
                <tr key={svc.id} style={{ background: idx % 2 === 1 ? 'rgba(59,130,246,0.02)' : 'transparent' }}>
                  <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--text-primary)' }}>{svc.service_name}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 10, fontWeight: 800, textTransform: 'capitalize',
                      padding: '3px 8px', borderRadius: 99, background: `${catColor}14`, color: catColor,
                    }}>{svc.service_category}</span>
                  </td>
                  <td style={tdStyle}>{svc.staff_name || '—'}</td>
                  <td style={{ ...tdStyle, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtDur(svc.actual_duration_minutes)}</td>
                  <td style={{ ...tdStyle, fontWeight: 700, color: '#059669' }}>QAR {svc.price}</td>
                  <td style={tdStyle}>
                    <span className={`status-pill ${svc.status === 'completed' ? 'status-completed' : 'status-on_hold'}`} style={{ fontSize: 10, padding: '2px 7px' }}>
                      {svc.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : (
      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No services recorded</div>
    )}
    {visit.notes && (
      <div style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 8,
        background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
        fontSize: 12, color: 'var(--text-warning)', display: 'flex', gap: 8,
      }}>
        <FileText size={14} style={{ flexShrink: 0 }} /> {visit.notes}
      </div>
    )}
    <div style={{ marginTop: 12, textAlign: 'right' }}>
      <Link
        to={`/visits/${visit.id}`}
        className="btn btn-ghost btn-sm"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        Open visit <ExternalLink size={12} />
      </Link>
    </div>
  </div>
);

const VisitHistoryTable: React.FC<{ visits: any[] }> = ({ visits }) => {
  const [expandedId, setExpandedId] = useState<number | null>(visits[0]?.id ?? null);
  const [sortKey, setSortKey] = useState<VisitSortKey>('date');
  const [sortDir, setSortDir] = useState<VisitSortDir>('desc');
  const [filter, setFilter] = useState<VisitFilter>('all');

  const toggleSort = (key: VisitSortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'status' ? 'asc' : 'desc'); }
  };

  const filtered = useMemo(() => {
    if (filter === 'active') return visits.filter(v => ['waiting', 'in_service', 'on_hold'].includes(v.status));
    if (filter === 'completed') return visits.filter(v => v.status === 'completed');
    return visits;
  }, [visits, filter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'duration':
          return dir * ((a.duration_minutes || 0) - (b.duration_minutes || 0));
        case 'revenue':
          return dir * ((a.total_price || 0) - (b.total_price || 0));
        case 'status':
          return dir * (a.status || '').localeCompare(b.status || '');
        case 'date':
        default:
          return dir * (new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime());
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const sortTh = (key: VisitSortKey, label: string, align: 'left' | 'right' = 'left') => (
    <th
      key={key}
      style={{ ...thStyle, textAlign: align, cursor: 'pointer' }}
      onClick={() => toggleSort(key)}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, justifyContent: align === 'right' ? 'flex-end' : 'flex-start', width: '100%' }}>
        {label}
        <SortIcon active={sortKey === key} dir={sortDir} />
      </span>
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Filter size={14} color="var(--text-muted)" />
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-base)', borderRadius: 10, padding: 3, border: '1px solid var(--border-light)' }}>
          {(['all', 'active', 'completed'] as VisitFilter[]).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
                background: filter === f ? 'var(--bg-elevated)' : 'transparent',
                color: filter === f ? 'var(--text-primary)' : 'var(--text-muted)',
                boxShadow: filter === f ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {f === 'all' ? 'All visits' : f}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
          {sorted.length} visit{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 44, paddingLeft: 16 }} />
              <th style={thStyle}>Work order</th>
              {sortTh('date', 'Entry')}
              {sortTh('status', 'Status')}
              <th style={thStyle}>Bay</th>
              <th style={thStyle}>Services</th>
              {sortTh('duration', 'Duration', 'right')}
              {sortTh('revenue', 'Revenue', 'right')}
              <th style={{ ...thStyle, textAlign: 'right', paddingRight: 18 }}>Pay</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((visit, rowIdx) => {
              const isOpen = expandedId === visit.id;
              const cfg = STATUS_CFG[visit.status] || STATUS_CFG.completed;
              const svcCount = visit.services?.length ?? 0;
              return (
                <React.Fragment key={visit.id}>
                  <tr
                    onClick={() => setExpandedId(isOpen ? null : visit.id)}
                    style={{
                      cursor: 'pointer',
                      background: isOpen
                        ? 'rgba(59,130,246,0.06)'
                        : rowIdx % 2 === 1
                          ? 'rgba(59,130,246,0.02)'
                          : 'transparent',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => {
                      if (!isOpen) e.currentTarget.style.background = rowIdx % 2 === 1 ? 'rgba(59,130,246,0.02)' : 'transparent';
                    }}
                  >
                    <td style={{ ...tdStyle, paddingLeft: 16, width: 44 }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: 8,
                        background: isOpen ? 'rgba(59,130,246,0.12)' : 'var(--bg-base)',
                        border: '1px solid var(--border-light)',
                        transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                        transition: 'transform 0.2s',
                      }}>
                        <ChevronDown size={14} color={isOpen ? 'var(--text-accent)' : 'var(--text-muted)'} />
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 12, color: 'var(--text-accent)' }}>
                      {visit.visit_number}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmtQatar(visit.entry_time, 'medDate')}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{fmtQatar(visit.entry_time, 'hm')}</div>
                    </td>
                    <td style={tdStyle}>
                      <span className={`status-pill status-${visit.status}`} style={{ fontSize: 10, padding: '3px 9px' }}>
                        {cfg.label}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {visit.assigned_bay ? (
                        <span className="badge badge-blue" style={{ fontSize: 10 }}>Bay {visit.assigned_bay}</span>
                      ) : '—'}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--text-primary)' }}>{svcCount}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtDur(visit.duration_minutes)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>
                      QAR {(visit.total_price || 0).toLocaleString()}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 18 }}>
                      <span className={`status-pill ${visit.payment_status === 'paid' ? 'pay-paid' : 'pay-pending'}`} style={{ fontSize: 10, padding: '2px 8px' }}>
                        {visit.payment_status}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                        <VisitServicesPanel visit={visit} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════
// VEHICLE PROFILE
// ══════════════════════════════════════════════
export const VehicleProfile: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<any>({});
  const [fixPlateOpen, setFixPlateOpen] = useState(false);
  const [fixPlateValue, setFixPlateValue] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['vehicle-history', id],
    queryFn: () => vehiclesApi.history(Number(id)).then(r => r.data),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: (d: any) => vehiclesApi.update(Number(id), d),
    onSuccess: () => {
      toast.success('Vehicle updated!');
      setEditMode(false);
      qc.invalidateQueries({ queryKey: ['vehicle-history', id] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Update failed'),
  });

  const fixPlateMutation = useMutation({
    mutationFn: ({ plate, merge }: { plate: string; merge: boolean }) =>
      vehiclesApi.correctPlate(Number(id), plate, merge),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['vehicle-history', id] });
      qc.invalidateQueries({ queryKey: ['vehicles'] });
      setFixPlateOpen(false);
      if (res.data?.merged_into) {
        toast.success('Merged into existing vehicle');
        navigate(`/vehicles/${res.data.merged_into}`);
      } else {
        toast.success('Plate corrected');
      }
    },
    onError: (e: unknown, vars) => {
      const err = e as { response?: { status?: number } };
      if (err?.response?.status === 409 && !vars.merge) {
        if (window.confirm('That plate already exists. Merge duplicate records?')) {
          fixPlateMutation.mutate({ ...vars, merge: true });
        }
        return;
      }
      toast.error('Could not correct plate');
    },
  });

  const chartSeries = useMemo(() => {
    const visits = data?.visits as any[] | undefined;
    if (!visits?.length) return [];
    const list = [...visits].sort(
      (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime()
    );
    return list.slice(-18).map((v: any, i: number) => ({
      n: i + 1,
      label: fmtQatar(v.entry_time, 'md'),
      revenue: Number(v.total_price) || 0,
      visitNo: v.visit_number,
    }));
  }, [data]);

  const insights = useMemo(() => {
    if (!data) return { avgTicket: 0, peak: null as any, peakAmt: 0, oldest: null as any, newest: null as any };
    const visits = (data.visits || []) as any[];
    const summary = data.summary;
    const avgTicket = summary.total_visits > 0 ? summary.total_spent / summary.total_visits : 0;
    let peak: any = null;
    let peakAmt = 0;
    visits.forEach((v: any) => {
      const p = Number(v.total_price) || 0;
      if (p > peakAmt) { peakAmt = p; peak = v; }
    });
    const oldest = visits.length ? visits[visits.length - 1] : null;
    const newest = visits.length ? visits[0] : null;
    return { avgTicket, peak, peakAmt, oldest, newest };
  }, [data]);

  const copyPlate = useCallback(() => {
    const plate = data?.vehicle?.plate_number;
    if (!plate) return;
    navigator.clipboard.writeText(plate).then(
      () => toast.success('Plate copied'),
      () => toast.error('Could not copy')
    );
  }, [data]);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <div className="spinner" style={{ width: 36, height: 36 }} />
      </div>
    );
  }

  if (!data) return null;

  const { vehicle, visits, summary } = data;
  const colorDot = COLOR_DOTS[vehicle.color?.toLowerCase()] || 'var(--border)';
  const isActive = visits?.some((v: any) => ['waiting','in_service','on_hold'].includes(v.status));

  const inputStyle = {
    width: '100%', padding: '8px 12px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: 8, color: 'var(--text-primary)',
    fontSize: 13, fontFamily: 'inherit', outline: 'none',
  };

  return (
    <div className="animate-fade-in">
      <style>{`
        @keyframes vprof-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes vprof-shimmer { 0%{background-position:0% 50%}100%{background-position:200% 50%} }
      `}</style>

      {/* Hero */}
      <div style={{
        position: 'relative',
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 20,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(125deg, rgba(59,130,246,0.09) 0%, rgba(139,92,246,0.07) 40%, rgba(16,185,129,0.06) 100%)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(110deg, transparent 38%, rgba(255,255,255,0.035) 50%, transparent 62%)',
          backgroundSize: '200% 100%', animation: 'vprof-shimmer 10s ease infinite',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', padding: '20px 22px 18px' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/vehicles')} style={{ marginBottom: 14 }}>
            <ArrowLeft size={14} /> Fleet registry
          </button>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
              padding: '5px 11px', borderRadius: 99,
              background: 'rgba(139,92,246,0.14)', color: 'var(--text-purple)', border: '1px solid rgba(167,139,250,0.35)',
            }}>
              <Sparkles size={11} /> Vehicle intelligence
            </span>
            {isActive && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '5px 11px', borderRadius: 99,
                background: 'rgba(16,185,129,0.14)', color: 'var(--text-success)', border: '1px solid rgba(52,211,153,0.35)',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', animation: 'vprof-pulse 2s ease infinite' }} />
                On-site now
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[
              { to: '/', label: 'Dashboard', icon: LayoutDashboard },
              { to: '/visits', label: 'Visits queue', icon: Calendar },
              { to: '/analytics', label: 'Analytics', icon: TrendingUp },
              { to: '/visionflow', label: 'ANPR', icon: Gauge },
            ].map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '7px 13px', borderRadius: 11,
                  background: 'var(--bg-surface)', border: '1px solid var(--border-light)',
                  color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                }}
              >
                <Icon size={13} color="var(--text-accent)" /> {label}
                <ArrowRight size={13} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Header card */}
      <div className="card" style={{ padding: '24px', marginBottom: 20, position: 'relative', overflow: 'hidden', border: '1px solid var(--border-light)' }}>
        {/* Active indicator top bar */}
        {isActive && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 3,
            background: 'linear-gradient(90deg, #3b82f6, #10b981)',
          }} />
        )}
        <div style={{
          position: 'absolute', inset: 'auto -20% -60% auto', width: '45%', height: '120%',
          background: 'radial-gradient(circle at 70% 30%, rgba(96,165,250,0.12) 0%, transparent 55%)',
          pointerEvents: 'none',
        }} />

        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
          {/* Plate + Icon */}
          <div>
            <div style={{
              background: 'linear-gradient(160deg, var(--input-bg), rgba(59,130,246,0.08))',
              border: '1px solid rgba(96,165,250,0.4)', borderRadius: 14, padding: '12px 22px', marginBottom: 12,
              fontFamily: 'monospace', fontWeight: 900, fontSize: 28, color: 'var(--text-accent)',
              letterSpacing: 4, textAlign: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
            }}>
              {vehicle.plate_number}
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={copyPlate} style={{ width: '100%', justifyContent: 'center', gap: 6 }}>
              <ClipboardCopy size={13} /> Copy plate
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: '100%', justifyContent: 'center', gap: 6, marginTop: 8 }}
              onClick={() => {
                setFixPlateValue(vehicle.plate_number || '');
                setFixPlateOpen(true);
              }}
            >
              <PenLine size={13} /> Fix plate
            </button>
            {isActive && (
              <div style={{
                marginTop: 10,
                display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                padding: '4px 12px', borderRadius: 99,
                background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)',
                fontSize: 11, fontWeight: 700, color: '#10b981',
              }}>
                <div style={{ position: 'relative', width: 7, height: 7 }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10b981', animation: 'ping 1.5s infinite', opacity: 0.6 }} />
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981' }} />
                </div>
                Currently In Shop
              </div>
            )}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 200 }}>
            {editMode ? (
              <div className="rcols-2" style={{ display: 'grid', gap: 10 }}>
                {[
                  { k: 'make', label: 'Make', placeholder: 'Toyota' },
                  { k: 'model', label: 'Model', placeholder: 'Camry' },
                  { k: 'year', label: 'Year', placeholder: '2024' },
                  { k: 'color', label: 'Color', placeholder: 'White' },
                  { k: 'owner_name', label: 'Owner Name' },
                  { k: 'owner_phone', label: 'Phone' },
                ].map(f => (
                  <div key={f.k}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</div>
                    <input
                      style={inputStyle}
                      placeholder={f.placeholder}
                      value={editForm[f.k] ?? vehicle[f.k] ?? ''}
                      onChange={e => setEditForm((p: any) => ({ ...p, [f.k]: e.target.value }))}
                    />
                  </div>
                ))}
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>Vehicle Type</div>
                  <select style={inputStyle} value={editForm.vehicle_type ?? vehicle.vehicle_type ?? 'sedan'}
                    onChange={e => setEditForm((p: any) => ({ ...p, vehicle_type: e.target.value }))}>
                    {['sedan','suv','truck','van','motorcycle','other'].map(t => <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>
                  {vehicle.make || 'Unknown Make'}{vehicle.model ? ` ${vehicle.model}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                  {vehicle.year && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{vehicle.year}</span>}
                  {vehicle.color && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: colorDot, border: '1px solid rgba(255,255,255,0.15)' }} />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{vehicle.color}</span>
                    </div>
                  )}
                  {vehicle.vehicle_type && (
                    <span className="badge badge-gray" style={{ textTransform: 'capitalize', fontSize: 11 }}>{vehicle.vehicle_type}</span>
                  )}
                  {vehicle.plate_country && (
                    <span className="badge badge-cyan" style={{ fontSize: 11 }}>🇶🇦 {vehicle.plate_country}</span>
                  )}
                </div>
                {vehicle.owner_name && (
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--text-secondary)' }}>
                    <User size={13} /> {vehicle.owner_name}
                    {vehicle.owner_phone && <span style={{ color: 'var(--text-muted)' }}>· {vehicle.owner_phone}</span>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Edit toggle */}
          <div style={{ display: 'flex', gap: 8 }}>
            {editMode ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => { setEditMode(false); setEditForm({}); }}>
                  <X size={13} /> Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => updateMutation.mutate(editForm)}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? <div className="spinner" style={{ width: 12, height: 12 }} /> : <Save size={13} />}
                  Save
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditMode(true)}>
                  <Edit size={13} /> Edit
                </button>
                <Link to={`/visits/new?plate=${vehicle.plate_number}`} className="btn btn-primary btn-sm">
                  <Plus size={13} /> New Visit
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        {[
          { label: 'Total Visits', value: summary.total_visits, icon: Calendar, color: 'var(--text-accent)', bg: 'var(--blue-dim)' },
          { label: 'Total Spent', value: `QAR ${summary.total_spent.toLocaleString()}`, icon: DollarSign, color: 'var(--text-purple)', bg: 'var(--purple-dim)' },
          { label: 'Avg Duration', value: summary.avg_duration_minutes ? `${Math.round(summary.avg_duration_minutes)}m` : '—', icon: Clock, color: 'var(--text-warning)', bg: 'var(--amber-dim)' },
          { label: 'Services Used', value: summary.services_used?.length ?? 0, icon: Wrench, color: 'var(--text-success)', bg: 'var(--emerald-dim)' },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="stat-card">
            <div className="stat-icon-wrap" style={{ background: bg }}>
              <Icon size={18} color={color} />
            </div>
            <div>
              <div className="stat-value" style={{ fontSize: 22 }}>{value}</div>
              <div className="stat-label" style={{ marginTop: 3 }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Intelligence + revenue rhythm */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
        gap: 16,
        marginBottom: 20,
      }}>
        <div className="card" style={{ padding: '18px 20px', borderRadius: 16, border: '1px solid var(--border-light)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 11,
              background: 'linear-gradient(135deg, rgba(139,92,246,0.22), rgba(59,130,246,0.18))',
              border: '1px solid rgba(167,139,250,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Sparkles size={17} color="var(--text-purple)" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>Customer signals</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Derived from visit history on file</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            <div style={{
              padding: '12px 14px', borderRadius: 12,
              background: 'var(--bg-base)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Avg ticket</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-purple)', marginTop: 4 }}>
                QAR {insights.avgTicket > 0 ? Math.round(insights.avgTicket).toLocaleString() : '—'}
              </div>
            </div>
            <div style={{
              padding: '12px 14px', borderRadius: 12,
              background: 'var(--bg-base)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Peak visit</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-warning)', marginTop: 4 }}>
                {insights.peakAmt > 0 ? `QAR ${insights.peakAmt.toLocaleString()}` : '—'}
              </div>
              {insights.peak?.visit_number && (
                <Link to={`/visits/${insights.peak.id}`} style={{ fontSize: 11, color: 'var(--text-accent)', marginTop: 6, display: 'inline-block', textDecoration: 'none', fontWeight: 600 }}>
                  {insights.peak.visit_number} →
                </Link>
              )}
            </div>
            <div style={{
              padding: '12px 14px', borderRadius: 12,
              background: 'var(--bg-base)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>First seen</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 6 }}>
                {insights.oldest?.entry_time
                  ? fmtQatar(insights.oldest.entry_time, 'medDate')
                  : '—'}
              </div>
              {insights.newest?.entry_time && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                  Last {formatDistanceToNow(new Date(insights.newest.entry_time), { addSuffix: true })}
                </div>
              )}
            </div>
          </div>
        </div>

        {chartSeries.length >= 2 && (
          <div className="card" style={{ padding: '18px 20px 12px', borderRadius: 16, border: '1px solid var(--border-light)', minHeight: 260 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>Revenue rhythm</div>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recent visits</span>
            </div>
            <div style={{ height: 200, minWidth: 0, minHeight: 200 }}>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartSeries} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="vprofRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}`} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
                      fontSize: 11, color: 'var(--text-primary)',
                    }}
                    formatter={(v: any) => [`QAR ${Number(v ?? 0).toLocaleString()}`, 'Ticket']}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="var(--text-purple)" strokeWidth={2} fill="url(#vprofRev)" dot={{ r: 3, fill: 'var(--text-purple)', strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* Services used chips */}
      {summary.services_used?.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Services:</span>
          {summary.services_used.map((s: string) => (
            <span key={s} style={{
              padding: '3px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 600,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
            }}>{s}</span>
          ))}
        </div>
      )}

      {/* Visit History */}
      <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)', padding: 0 }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-elevated)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Layers size={16} color="var(--text-accent)" />
              Visit history
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
              Click a row to expand service line items · Sort and filter below
            </div>
          </div>
          <BarChart2 size={18} color="var(--text-muted)" />
        </div>
        <div style={{ padding: '16px 18px 18px' }}>
          {visits?.length === 0 ? (
            <div className="empty-state">
              <Car size={36} />
              <h3>No visits yet</h3>
              <p>Register the first visit for this vehicle</p>
              <Link to={`/visits/new?plate=${vehicle.plate_number}`} className="btn btn-primary" style={{ marginTop: 14 }}>
                <Plus size={14} /> New Visit
              </Link>
            </div>
          ) : (
            <VisitHistoryTable visits={visits} />
          )}
        </div>
      </div>

      {fixPlateOpen && (
        <div className="modal-backdrop" onClick={() => setFixPlateOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Fix plate</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setFixPlateOpen(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
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
                onClick={() => fixPlateMutation.mutate({ plate: fixPlateValue.trim(), merge: false })}
              >
                {fixPlateMutation.isPending ? 'Saving…' : 'Save corrected plate'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes ping { 75%,100%{transform:scale(2.5);opacity:0} }
      `}</style>
    </div>
  );
};
