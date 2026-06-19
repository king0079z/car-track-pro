import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Search, LogOut, Eye, Trash2, X,
  Car, Zap, Download, Calendar, TrendingUp,
  DollarSign, Clock, CheckCircle, AlertTriangle, ChevronLeft, ChevronRight,
  ClipboardList, RefreshCw, BarChart3, Gauge, ArrowRight, Sparkles,
  ChevronDown, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, Layers, Wrench,
} from 'lucide-react';
import { visitsApi } from '../../services/api';
import { visitShopDurationMinutes, isActiveVisitStatus } from '../../utils/visitDuration';
import {
  fmtQatar,
  qatarStartOfMonth,
  qatarStartOfToday,
  qatarStartOfWeekMonday,
  qatarEndOfToday,
  qatarYmd,
  qatarYmdAddDays,
  zonedBoundsFromYmd,
} from '../../lib/qatarTime';
import toast from 'react-hot-toast';
import type { Visit, VisitStatus } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { isOrgWideUser } from '../../lib/permissions';
import { OpsQuickNav } from '../../components/ops/OpsQuickNav';

function useLiveTimer(entryTime: string) {
  const [mins, setMins] = useState(() =>
    Math.floor((Date.now() - new Date(entryTime).getTime()) / 60000)
  );
  React.useEffect(() => {
    const t = setInterval(() => {
      setMins(Math.floor((Date.now() - new Date(entryTime).getTime()) / 60000));
    }, 30000);
    return () => clearInterval(t);
  }, [entryTime]);
  return mins;
}

function fmtDur(m: number) {
  if (!m || m < 0) return '—';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_LABELS: Record<VisitStatus, string> = {
  waiting: 'Waiting', in_service: 'In Service',
  on_hold: 'On Hold', completed: 'Completed', cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<VisitStatus, { color: string; bg: string }> = {
  waiting:    { color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)' },
  in_service: { color: 'var(--text-accent)', bg: 'rgba(147,197,253,0.12)' },
  on_hold:    { color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
  completed:  { color: 'var(--text-success)', bg: 'rgba(110,231,183,0.12)' },
  cancelled:  { color: 'var(--text-danger)', bg: 'rgba(252,165,165,0.12)' },
};

const PaymentMini: React.FC<{ status?: string }> = ({ status }) => {
  const s = (status || 'unpaid').toLowerCase();
  const cfg =
    s === 'paid'
      ? { bg: 'rgba(16,185,129,0.14)', c: '#34d399', t: 'Paid' }
      : s === 'partial' || s === 'partially_paid'
        ? { bg: 'rgba(245,158,11,0.14)', c: 'var(--text-warning)', t: 'Partial' }
        : { bg: 'rgba(148,163,184,0.12)', c: '#94a3b8', t: 'Due' };
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
      padding: '3px 9px', borderRadius: 99, background: cfg.bg, color: cfg.c,
    }}>{cfg.t}</span>
  );
};

const StatusPill: React.FC<{ status: VisitStatus }> = ({ status }) => {
  const cfg = STATUS_COLORS[status] || { color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 99,
      background: cfg.bg, color: cfg.color,
      fontSize: 11, fontWeight: 700,
    }}>
      {status === 'in_service' && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, animation: 'pulse2 1.5s infinite' }} />
      )}
      {STATUS_LABELS[status] || status}
    </span>
  );
};

const TimerCell: React.FC<{ visit: Visit }> = ({ visit }) => {
  const wallMins = useLiveTimer(visit.entry_time);
  const isActive = isActiveVisitStatus(visit.status);
  const shopMins = visitShopDurationMinutes(visit);
  const mins = shopMins ?? wallMins;
  const display = fmtDur(Math.round(mins));
  const color = mins > 120 ? '#ef4444' : mins > 60 ? '#f59e0b' : '#10b981';

  return (
    <div>
      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: isActive ? color : 'var(--text-muted)' }}>
        {display}
      </span>
      {isActive && mins > 120 && (
        <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 600, marginTop: 1 }}>⚠ Overdue</div>
      )}
    </div>
  );
};

const DATE_FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
];

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'Waiting', value: 'waiting' },
  { label: 'In Service', value: 'in_service' },
  { label: 'On Hold', value: 'on_hold' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const PAGE_SIZE = 20;

type SortKey = 'visit' | 'plate' | 'entry' | 'duration' | 'status' | 'revenue';
type SortDir = 'asc' | 'desc';

function dateRangeForFilter(dateFilter: string, now = new Date()): { start: Date; end: Date } | null {
  switch (dateFilter) {
    case 'today':
      return { start: qatarStartOfToday(now), end: qatarEndOfToday(now) };
    case 'yesterday':
      return zonedBoundsFromYmd(qatarYmdAddDays(qatarYmd(now), -1));
    case 'week':
      return { start: qatarStartOfWeekMonday(now), end: qatarEndOfToday(now) };
    case 'month':
      return { start: qatarStartOfMonth(now), end: qatarEndOfToday(now) };
    default:
      return null;
  }
}

function visitInDateRange(entryTime: string, range: { start: Date; end: Date } | null): boolean {
  if (!range) return true;
  const t = new Date(entryTime).getTime();
  if (Number.isNaN(t)) return false;
  return t >= range.start.getTime() && t <= range.end.getTime();
}

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
  padding: '13px 14px',
  fontSize: 13,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-light)',
  verticalAlign: 'middle',
};

const SortIcon: React.FC<{ active: boolean; dir: SortDir }> = ({ active, dir }) => {
  if (!active) return <ArrowUpDown size={11} style={{ opacity: 0.35 }} />;
  return dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
};

const VisitExpandPanel: React.FC<{
  visit: Visit;
  onCheckout: () => void;
  onDelete: () => void;
  onOpen: () => void;
}> = ({ visit, onCheckout, onDelete, onOpen }) => {
  const active = ['waiting', 'in_service', 'on_hold'].includes(visit.status);
  return (
    <div className="expand-panel" style={{
      background: 'linear-gradient(180deg, rgba(59,130,246,0.04) 0%, var(--bg-base) 100%)',
      borderTop: '1px solid var(--border-light)',
    }}>
      <div className="rcols-1-auto" style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 12 }}>
            Visit details
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: visit.service_items?.length ? 16 : 0 }}>
            {[
              { label: 'Work order', value: visit.visit_number },
              { label: 'Customer', value: visit.customer_name || '—' },
              { label: 'Phone', value: visit.customer_phone || '—' },
              { label: 'Email', value: visit.customer_email || '—' },
              { label: 'Exit', value: visit.exit_time ? fmtQatar(visit.exit_time, 'dmyHm') : '—' },
            ].map(item => (
              <div key={item.label} style={{ minWidth: 120 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>{item.value}</div>
              </div>
            ))}
          </div>
          {visit.service_items && visit.service_items.length > 0 && (
            <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wrench size={12} /> Service line items
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {visit.service_items.map((si, i) => (
                  <span key={i} style={{
                    fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 99,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)',
                  }}>
                    {si.service?.name || 'Service'} · QAR {(si.price ?? 0).toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
          )}
          {visit.notes && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>Notes</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{visit.notes}</div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); onOpen(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Eye size={13} /> Open visit
          </button>
          {active && (
            <button type="button" className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); onCheckout(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <LogOut size={13} /> Checkout
            </button>
          )}
          {visit.vehicle_id && (
            <Link
              to={`/vehicles/${visit.vehicle_id}`}
              className="btn btn-secondary btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
              onClick={e => e.stopPropagation()}
            >
              <Car size={13} /> Vehicle profile
            </Link>
          )}
          <button type="button" className="btn btn-danger btn-sm" onClick={e => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
};

function exportCSV(visits: Visit[]) {
  const headers = ['Visit #', 'Plate', 'Vehicle', 'Customer', 'Bay', 'Entry', 'Exit', 'Duration', 'Status', 'Services', 'Total (QAR)'];
  const rows = visits.map(v => [
    v.visit_number,
    v.vehicle?.plate_number || '',
    v.vehicle ? `${v.vehicle.make || ''} ${v.vehicle.model || ''}`.trim() : '',
    v.customer_name || '',
    v.assigned_bay ? `Bay ${v.assigned_bay}` : '',
    v.entry_time ? fmtQatar(v.entry_time, 'csvDmyHm') : '',
    v.exit_time ? fmtQatar(v.exit_time, 'csvDmyHm') : '',
    v.duration_minutes ? fmtDur(Math.round(v.duration_minutes)) : '',
    v.status,
    v.service_items?.map(s => s.service?.name).join('; ') || '',
    v.total_price > 0 ? v.total_price.toFixed(2) : '0',
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `visits-${qatarYmd()}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast.success('CSV exported!');
}

export const VisitsList: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const floorView = searchParams.get('view') === 'floor';
  const qc = useQueryClient();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const orgWide = isOrgWideUser(user);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<VisitStatus | ''>('');
  const [dateFilter, setDateFilter] = useState('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(floorView ? 'duration' : 'entry');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data: visits = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['visits', status],
    queryFn: () => visitsApi.list({ status: status || undefined, limit: 500 }).then(r => r.data),
    refetchInterval: 15000,
    enabled: isAuthenticated && !authLoading,
    retry: 3,
    refetchOnMount: 'always',
  });

  React.useEffect(() => {
    if (floorView) setSortKey('duration');
  }, [floorView]);

  const checkoutMutation = useMutation({
    mutationFn: (id: number) => visitsApi.checkout(id),
    onSuccess: () => { toast.success('Checked out successfully'); qc.invalidateQueries({ queryKey: ['visits'] }); qc.invalidateQueries({ queryKey: ['services'] }); },
    onError: () => toast.error('Checkout failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => visitsApi.delete(id),
    onSuccess: () => { toast.success('Visit deleted'); setDeleteId(null); qc.invalidateQueries({ queryKey: ['visits'] }); },
    onError: () => toast.error('Delete failed'),
  });

  const getDateRange = useCallback(() => dateRangeForFilter(dateFilter), [dateFilter]);

  const dateScoped = useMemo(() => {
    const range = getDateRange();
    return (visits as Visit[]).filter(v => visitInDateRange(v.entry_time, range));
  }, [visits, getDateRange]);

  const filtered = useMemo(() => {
    return dateScoped.filter(v => {
      if (floorView && !status && !['waiting', 'in_service', 'on_hold'].includes(v.status)) {
        return false;
      }
      if (overdueOnly) {
        const mins = Math.floor((Date.now() - new Date(v.entry_time).getTime()) / 60000);
        if (mins <= 90 || !['waiting', 'in_service', 'on_hold'].includes(v.status)) return false;
      }
      const textMatch = !search ||
        v.vehicle?.plate_number?.toLowerCase().includes(search.toLowerCase()) ||
        v.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
        v.visit_number?.toLowerCase().includes(search.toLowerCase());
      return textMatch;
    });
  }, [dateScoped, search, floorView, status, overdueOnly]);

  const counts = useMemo(() => dateScoped.reduce((acc, v) => {
    acc[v.status] = (acc[v.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>), [dateScoped]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const active = filtered.filter(v => ['waiting', 'in_service', 'on_hold'].includes(v.status));
    const completed = filtered.filter(v => v.status === 'completed');
    const revenue = filtered.reduce((s, v) => s + (v.total_price || 0), 0);
    const withDur = completed.filter(v => v.duration_minutes != null && v.duration_minutes > 0);
    const avgDur = withDur.length
      ? Math.round(withDur.reduce((s, v) => s + (v.duration_minutes || 0), 0) / withDur.length)
      : 0;
    const overdueActive = active.filter(v => {
      const m = Math.floor((Date.now() - new Date(v.entry_time).getTime()) / 60000);
      return m > 120;
    }).length;
    return { active: active.length, completed: completed.length, revenue, avgDur, overdueActive };
  }, [filtered]);

  const refreshList = () => {
    qc.invalidateQueries({ queryKey: ['visits'] });
    toast.success('Visits refreshed');
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'entry' || key === 'duration' || key === 'revenue' ? 'desc' : 'asc'); }
  };

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case 'visit':
          return dir * (a.visit_number || '').localeCompare(b.visit_number || '');
        case 'plate':
          return dir * (a.vehicle?.plate_number || '').localeCompare(b.vehicle?.plate_number || '');
        case 'entry':
          return dir * (new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime());
        case 'duration': {
          const da = a.duration_minutes ?? (Date.now() - new Date(a.entry_time).getTime()) / 60000;
          const db = b.duration_minutes ?? (Date.now() - new Date(b.entry_time).getTime()) / 60000;
          return dir * (da - db);
        }
        case 'status':
          return dir * a.status.localeCompare(b.status);
        case 'revenue':
          return dir * ((a.total_price || 0) - (b.total_price || 0));
        default:
          return 0;
      }
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const sortTh = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
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

  // Reset page when filters change
  React.useEffect(() => setPage(1), [search, status, dateFilter]);

  return (
    <div className="animate-fade-in">
      <style>{`
        @keyframes pulse2 { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes visits-shimmer { 0%{background-position:0% 50%}100%{background-position:200% 50%} }
      `}</style>

      <OpsQuickNav primaryAction={{ to: '/visits/new', label: 'Work order' }} />

      {/* Hero */}
      <div style={{
        position: 'relative',
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 22,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(139,92,246,0.07) 50%, rgba(16,185,129,0.05) 100%)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(110deg, transparent 40%, rgba(255,255,255,0.03) 50%, transparent 60%)',
          backgroundSize: '200% 100%', animation: 'visits-shimmer 8s ease infinite',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', padding: '26px 28px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 54, height: 54, borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.35), rgba(139,92,246,0.28))',
                border: '1px solid rgba(139,92,246,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 14px 44px rgba(59,130,246,0.22)',
              }}>
                <ClipboardList size={28} color="#e0e7ff" />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  <h1 className="page-title" style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>
                    {floorView ? 'Shop floor' : 'Visits'}
                  </h1>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase',
                    padding: '5px 12px', borderRadius: 99,
                    background: 'rgba(59,130,246,0.15)', color: 'var(--text-accent)', border: '1px solid rgba(59,130,246,0.35)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-accent)', animation: 'pulse2 2s ease infinite' }} />
                    Live queue
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 540, lineHeight: 1.65 }}>
                  {orgWide ? (
                    <>
                      Command center for every shop entry — durations update while cars are on-site. Tie-ins with{' '}
                      <Link to="/analytics" style={{ color: 'var(--text-accent)', fontWeight: 700 }}>Analytics</Link>,{' '}
                      <Link to="/visionflow" style={{ color: 'var(--text-accent)', fontWeight: 700 }}>ANPR</Link>, and{' '}
                      <Link to="/vehicles" style={{ color: 'var(--text-accent)', fontWeight: 700 }}>Vehicles</Link>.
                    </>
                  ) : (
                    <>
                      Your work orders — only visits you created or signed appear here. Create a new order anytime; your name is applied automatically at sign-off.
                    </>
                  )}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={refreshList} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Refresh
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => exportCSV(filtered)}
                disabled={filtered.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Download size={14} /> Export
              </button>
              <Link to="/visits/new" className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Plus size={15} /> New work order
              </Link>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
            {[
              { to: '/analytics', label: 'Analytics', icon: BarChart3 },
              { to: '/vehicles', label: 'Vehicle registry', icon: Car },
              { to: '/visionflow', label: 'ANPR & speed', icon: Gauge },
              { to: '/services', label: 'Services', icon: Sparkles },
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
                <Icon size={14} color="var(--text-accent)" /> {label}
                <ArrowRight size={14} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
        gap: 12,
        marginBottom: 20,
      }}>
        {[
          { label: 'In view', value: filtered.length, sub: 'Matches filters', icon: Car, color: 'var(--text-accent)', accent: 'rgba(59,130,246,0.45)' },
          { label: 'Active now', value: summaryStats.active, sub: summaryStats.overdueActive ? `${summaryStats.overdueActive} over 2h` : 'On the floor', icon: Clock, color: 'var(--text-warning)', accent: 'rgba(251,191,36,0.45)' },
          { label: 'Completed', value: summaryStats.completed, sub: summaryStats.avgDur ? `Avg ${summaryStats.avgDur}m stay` : 'In range', icon: CheckCircle, color: 'var(--text-success)', accent: 'rgba(52,211,153,0.45)' },
          { label: 'Revenue', value: `QAR ${Math.round(summaryStats.revenue).toLocaleString()}`, sub: 'Filtered total', icon: DollarSign, color: 'var(--text-purple)', accent: 'rgba(196,181,253,0.45)' },
        ].map(s => (
          <div
            key={s.label}
            style={{
              position: 'relative',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
              borderRadius: 16, padding: '16px 18px',
              overflow: 'hidden', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
              (e.currentTarget as HTMLDivElement).style.boxShadow = '0 12px 36px rgba(0,0,0,0.18)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLDivElement).style.transform = '';
              (e.currentTarget as HTMLDivElement).style.boxShadow = '';
            }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${s.accent}, transparent)` }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 12,
                background: `${s.color}14`, border: `1px solid ${s.color}33`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <s.icon size={18} color={s.color} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>{s.value}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{s.sub}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Status + filters shell */}
      <div className="card" style={{ padding: '16px 18px', marginBottom: 18, borderRadius: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>
          Workflow
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.value || 'all'}
              type="button"
              onClick={() => setStatus(tab.value as VisitStatus | '')}
              style={{
                padding: '8px 16px', borderRadius: 11, fontSize: 13, fontWeight: 700,
                cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.18s',
                background: status === tab.value ? 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(139,92,246,0.15))' : 'var(--bg-base)',
                color: status === tab.value ? '#fff' : 'var(--text-secondary)',
                borderColor: status === tab.value ? 'rgba(139,92,246,0.35)' : 'var(--border)',
                boxShadow: status === tab.value ? '0 6px 18px rgba(59,130,246,0.25)' : 'none',
              }}
            >
              {tab.label}
              {tab.value && counts[tab.value] > 0 && (
                <span style={{
                  marginLeft: 8, fontSize: 10, fontWeight: 800,
                  background: status === tab.value ? 'rgba(255,255,255,0.2)' : 'var(--bg-elevated)',
                  borderRadius: 99, padding: '2px 8px',
                }}>
                  {counts[tab.value]}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className={`ops-queue-tab${overdueOnly ? ' active warn' : ''}`}
            onClick={() => setOverdueOnly(v => !v)}
            title="Show vehicles waiting more than 90 minutes"
          >
            <AlertTriangle size={12} /> Overdue{summaryStats.overdueActive > 0 ? ` (${summaryStats.overdueActive})` : ''}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search-wrap" style={{ flex: '1 1 240px', maxWidth: 420 }}>
            <Search size={14} />
            <input
              className="input search-input"
              placeholder="Search plate, customer, visit #..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {DATE_FILTERS.map(df => (
              <button
                key={df.value}
                type="button"
                onClick={() => setDateFilter(df.value)}
                style={{
                  padding: '8px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 700,
                  cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.15s',
                  background: dateFilter === df.value ? 'rgba(139,92,246,0.22)' : 'var(--bg-base)',
                  color: dateFilter === df.value ? 'var(--text-accent)' : 'var(--text-secondary)',
                  borderColor: dateFilter === df.value ? 'rgba(167,139,250,0.45)' : 'var(--border)',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {df.value !== 'all' && <Calendar size={12} />}
                {df.label}
              </button>
            ))}
          </div>
          {(search || dateFilter !== 'all') && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setDateFilter('all'); }}>
              <X size={12} /> Reset filters
            </button>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
            <TrendingUp size={13} style={{ verticalAlign: 'middle', marginRight: 6, opacity: 0.7 }} />
            {filtered.length} result{filtered.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden', borderRadius: 16, border: '1px solid var(--border-light)', padding: 0 }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-elevated)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Layers size={16} color="var(--text-accent)" />
              Visit ledger
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
              Click a row to expand details · Sort columns · Double-click row to open visit
            </div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{sorted.length} records</span>
        </div>
        {isLoading || (authLoading && !visits.length) ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 64, flexDirection: 'column', gap: 12 }}>
            <div className="spinner" style={{ width: 32, height: 32 }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading visits...</span>
          </div>
        ) : isError ? (
          <div className="empty-state">
            <AlertTriangle size={36} color="var(--text-warning)" style={{ marginBottom: 12 }} />
            <h3>Could not load visits</h3>
            <p>The server may be restarting. Retry in a moment.</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => refetch()}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : paginated.length === 0 ? (
          <div className="empty-state">
            <div style={{
              width: 64, height: 64, borderRadius: '50%', background: 'rgba(59,130,246,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <Car size={30} color="var(--text-accent)" />
            </div>
            <h3>No visits found</h3>
            <p>
              {dateScoped.length > 0 && filtered.length === 0
                ? 'Active filters hide matching visits — try Reset filters or choose All dates.'
                : dateFilter !== 'all' && (visits as Visit[]).length > 0
                  ? `No visits in this date range. ${(visits as Visit[]).length} total on file — switch to All to browse history.`
                  : 'Try adjusting your filters or register a new entry.'}
            </p>
            {(search || dateFilter !== 'all' || overdueOnly || floorView) && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 12 }}
                onClick={() => { setSearch(''); setDateFilter('all'); setOverdueOnly(false); setStatus(''); navigate('/visits'); }}
              >
                <X size={12} /> Clear all filters
              </button>
            )}
            <Link to="/visits/new" className="btn btn-primary" style={{ marginTop: 16 }}>
              <Zap size={14} /> New work order
            </Link>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 36, paddingLeft: 14 }} />
                    {sortTh('visit', 'Visit #')}
                    {sortTh('plate', 'Plate')}
                    <th style={thStyle}>Vehicle</th>
                    <th style={thStyle}>Customer</th>
                    <th style={thStyle}>Bay</th>
                    {sortTh('entry', 'Entry')}
                    {sortTh('duration', 'Duration')}
                    {sortTh('status', 'Status')}
                    <th style={thStyle}>Pay</th>
                    {sortTh('revenue', 'Revenue', 'right')}
                    <th style={{ ...thStyle, textAlign: 'right', paddingRight: 16 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((visit: Visit) => {
                    const activeRow = ['waiting', 'in_service', 'on_hold'].includes(visit.status);
                    const expanded = expandedId === visit.id;
                    return (
                      <React.Fragment key={visit.id}>
                        <tr
                          style={{
                            cursor: 'pointer',
                            transition: 'background 0.14s ease',
                            background: expanded ? 'rgba(59,130,246,0.06)' : activeRow ? 'rgba(59,130,246,0.02)' : 'transparent',
                            boxShadow: activeRow ? 'inset 3px 0 0 var(--text-accent)' : 'none',
                          }}
                          onClick={() => setExpandedId(expanded ? null : visit.id)}
                          onDoubleClick={() => navigate(`/visits/${visit.id}`)}
                          onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = expanded ? 'rgba(59,130,246,0.06)' : activeRow ? 'rgba(59,130,246,0.02)' : 'transparent';
                          }}
                        >
                          <td style={{ ...tdStyle, paddingLeft: 14, width: 36 }}>
                            <ChevronDown
                              size={14}
                              color="var(--text-muted)"
                              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                            />
                          </td>
                          <td style={tdStyle}>
                            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700 }}>
                              {visit.visit_number}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 13,
                              color: 'var(--text-accent)', background: 'rgba(59,130,246,0.08)',
                              padding: '3px 10px', borderRadius: 8, letterSpacing: '0.04em',
                            }}>
                              {visit.vehicle?.plate_number}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            {visit.vehicle?.make
                              ? <><span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{visit.vehicle.make}</span> {visit.vehicle.model || ''}</>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          <td style={tdStyle}>{visit.customer_name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                          <td style={tdStyle}>
                            {visit.assigned_bay
                              ? <span className="badge badge-blue">Bay {visit.assigned_bay}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmtQatar(visit.entry_time, 'dayMonEn')}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtQatar(visit.entry_time, 'hm')}</div>
                          </td>
                          <td style={tdStyle}><TimerCell visit={visit} /></td>
                          <td style={tdStyle}><StatusPill status={visit.status} /></td>
                          <td style={tdStyle}><PaymentMini status={visit.payment_status} /></td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                            {visit.total_price > 0
                              ? <span style={{ color: 'var(--text-purple)' }}>QAR {visit.total_price.toLocaleString()}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 16 }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                              <Link
                                to={`/visits/${visit.id}`}
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: 11, padding: '4px 8px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <ExternalLink size={11} /> Open
                              </Link>
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={12} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                              <VisitExpandPanel
                                visit={visit}
                                onCheckout={() => checkoutMutation.mutate(visit.id)}
                                onDelete={() => setDeleteId(visit.id)}
                                onOpen={() => navigate(`/visits/${visit.id}`)}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="pagination-bar" style={{
                padding: '14px 20px', borderTop: '1px solid var(--border-light)',
                background: 'var(--bg-base)',
              }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length}
                </span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    const p = page <= 3 ? i + 1 : page + i - 2;
                    if (p < 1 || p > totalPages) return null;
                    return (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        style={{
                          width: 32, height: 32, borderRadius: 8, fontSize: 13, fontWeight: 600,
                          cursor: 'pointer', border: '1px solid transparent',
                          background: p === page ? 'rgba(59,130,246,0.2)' : 'var(--bg-elevated)',
                          color: p === page ? 'var(--text-accent)' : 'var(--text-secondary)',
                          borderColor: p === page ? 'rgba(59,130,246,0.3)' : 'var(--border)',
                        }}
                      >
                        {p}
                      </button>
                    );
                  })}
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete Modal */}
      {deleteId !== null && (
        <div className="modal-backdrop" onClick={() => setDeleteId(null)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={16} color="#ef4444" /> Delete Visit?
              </h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setDeleteId(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                This will permanently delete the visit and all associated service data. This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteId(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => deleteId && deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending
                  ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Deleting...</>
                  : <><Trash2 size={13} /> Delete Visit</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
