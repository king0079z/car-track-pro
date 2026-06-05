import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  Car, Search, Plus, Trash2, History,
  X, Users, Clock, TrendingUp,
  Download,
  ScanLine, ArrowRight, RefreshCw, Gauge,
  LayoutGrid, List, Eye, LayoutDashboard, BarChart2,
  ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, Layers, Mail, Phone,
} from 'lucide-react';
import { vehiclesApi } from '../../services/api';
import { fmtQatar, qatarYmd } from '../../lib/qatarTime';
import toast from 'react-hot-toast';
import type { Vehicle } from '../../types';
/* ─── Constants ──────────────────────────────────────────────────────────── */
const COLOR_DOTS: Record<string, string> = {
  white: '#f9fafb', black: '#111827', silver: '#9ca3af', gray: '#6b7280',
  blue: '#3b82f6', red: '#ef4444', green: '#10b981', yellow: '#eab308',
  orange: '#f97316', brown: '#92400e', gold: '#d97706', beige: '#d6bcac',
  maroon: '#7f1d1d', navy: '#1e3a5f', pink: '#ec4899', purple: '#8b5cf6',
};

const TYPE_COLORS: Record<string, string> = {
  sedan: 'var(--text-accent)', suv: '#34d399', truck: '#fb923c',
  van: '#a78bfa', motorcycle: '#f472b6', other: '#94a3b8',
};

const VEHICLE_TYPES = ['all', 'sedan', 'suv', 'truck', 'van', 'motorcycle', 'other'];

type SortKey = 'plate' | 'vehicle' | 'type' | 'owner' | 'visits' | 'last_visit';
type SortDir = 'asc' | 'desc';

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

const VehicleExpandPanel: React.FC<{
  vehicle: Vehicle;
  onDelete: () => void;
}> = ({ vehicle, onDelete }) => {
  const tc = TYPE_COLORS[vehicle.vehicle_type || 'other'] || '#94a3b8';
  const colorDot = COLOR_DOTS[vehicle.color?.toLowerCase() || ''];
  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(16,185,129,0.04) 0%, var(--bg-base) 100%)',
      borderTop: '1px solid var(--border-light)',
      padding: '18px 20px 20px 62px',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 12 }}>
            Vehicle details
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            {[
              { label: 'Plate', value: vehicle.plate_number },
              { label: 'Make / Model', value: `${vehicle.make || '—'} ${vehicle.model || ''}`.trim() },
              { label: 'Year', value: vehicle.year ? String(vehicle.year) : '—' },
              {
                label: 'Color',
                value: vehicle.color ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textTransform: 'capitalize' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: colorDot || vehicle.color, border: '1px solid var(--border-light)' }} />
                    {vehicle.color}
                  </span>
                ) : '—',
              },
              {
                label: 'Type',
                value: (
                  <span style={{
                    fontSize: 11, fontWeight: 800, textTransform: 'uppercase',
                    padding: '3px 10px', borderRadius: 99, background: `${tc}18`, color: tc,
                  }}>{vehicle.vehicle_type || '—'}</span>
                ),
              },
              { label: 'Total visits', value: String(vehicle.total_visits ?? 0) },
              { label: 'Last visit', value: vehicle.last_visit ? fmtQatar(vehicle.last_visit, 'medDate') : 'Never' },
            ].map(item => (
              <div key={item.label} style={{ minWidth: 120 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>{item.value}</div>
              </div>
            ))}
          </div>
          {(vehicle.owner_name || vehicle.owner_phone || vehicle.owner_email) && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 10 }}>Owner</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13 }}>
                {vehicle.owner_name && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--text-primary)' }}>
                    <Users size={14} color="var(--text-muted)" /> {vehicle.owner_name}
                  </span>
                )}
                {vehicle.owner_phone && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                    <Phone size={14} color="var(--text-muted)" /> {vehicle.owner_phone}
                  </span>
                )}
                {vehicle.owner_email && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                    <Mail size={14} color="var(--text-muted)" /> {vehicle.owner_email}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <Link
            to={`/vehicles/${vehicle.id}`}
            className="btn btn-primary btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
            onClick={e => e.stopPropagation()}
          >
            <Eye size={13} /> Full profile
          </Link>
          <Link
            to={`/visits/new?plate=${encodeURIComponent(vehicle.plate_number)}`}
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
            onClick={e => e.stopPropagation()}
          >
            <Plus size={13} /> New visit
          </Link>
          <button type="button" className="btn btn-danger btn-sm" onClick={e => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
};

/* ─── Vehicle Card (grid view) ───────────────────────────────────────────── */
const VehicleCard: React.FC<{ vehicle: Vehicle; onDelete: () => void }> = ({ vehicle, onDelete }) => {
  const colorDot  = COLOR_DOTS[vehicle.color?.toLowerCase() || ''];
  const typeColor = TYPE_COLORS[vehicle.vehicle_type || 'other'] || '#94a3b8';

  return (
    <Link
      to={`/vehicles/${vehicle.id}`}
      style={{ textDecoration: 'none' }}
    >
      <div
        className="card"
        style={{
          padding: '18px', cursor: 'pointer',
          transition: 'all 0.22s cubic-bezier(0.22, 1, 0.36, 1)', position: 'relative', overflow: 'hidden',
          border: '1px solid var(--border-light)',
          borderTop: `3px solid ${typeColor}`,
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement;
          el.style.transform = 'translateY(-4px)';
          el.style.boxShadow = `0 16px 48px rgba(0,0,0,0.38), 0 0 0 1px ${typeColor}35`;
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement;
          el.style.transform = '';
          el.style.boxShadow = '';
        }}
      >
        <div style={{
          position: 'absolute', inset: '-40% -20% auto auto', width: '55%', height: '70%',
          background: `radial-gradient(circle at 70% 20%, ${typeColor}14 0%, transparent 65%)`,
          pointerEvents: 'none',
        }} />
        {/* Plate + Actions */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, position: 'relative', zIndex: 1 }}>
          <div style={{
            background: 'linear-gradient(145deg, var(--input-bg), rgba(59,130,246,0.06))',
            border: '1px solid rgba(96,165,250,0.35)', borderRadius: 10, padding: '6px 14px',
            fontFamily: 'monospace', fontWeight: 900, fontSize: 17, color: 'var(--text-accent)',
            letterSpacing: 3, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
          }}>
            {vehicle.plate_number}
          </div>
          <button
            className="btn btn-danger btn-icon"
            style={{ width: 28, height: 28 }}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
          >
            <Trash2 size={11} />
          </button>
        </div>

        {/* Name + type badge */}
        <div style={{ marginBottom: 12, position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 5 }}>
            {vehicle.make || 'Unknown'} {vehicle.model || ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {vehicle.year && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{vehicle.year}</span>}
            {vehicle.color && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: colorDot || vehicle.color, border: '1px solid rgba(255,255,255,0.15)' }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{vehicle.color}</span>
              </div>
            )}
            {vehicle.vehicle_type && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                background: `${typeColor}18`, color: typeColor, textTransform: 'uppercase', letterSpacing: 0.5,
              }}>{vehicle.vehicle_type}</span>
            )}
          </div>
        </div>

        {/* Owner */}
        {(vehicle.owner_name || vehicle.owner_phone) && (
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6, position: 'relative', zIndex: 1 }}>
            <Users size={11} color="var(--text-muted)" />
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {vehicle.owner_name || ''}
              {vehicle.owner_phone && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{vehicle.owner_phone}</span>}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          borderTop: '1px solid var(--border-light)', paddingTop: 12,
          position: 'relative', zIndex: 1,
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-accent)' }}>{vehicle.total_visits ?? 0}</div>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 1 }}>Visits</div>
          </div>
          <div style={{ textAlign: 'center', borderLeft: '1px solid var(--border-light)', borderRight: '1px solid var(--border-light)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
              {vehicle.last_visit ? fmtQatar(vehicle.last_visit, 'dayMonEn') : '—'}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 1 }}>Last Visit</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-purple)' }}>
              {vehicle.owner_name ? vehicle.owner_name.split(' ')[0] : '—'}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 1 }}>Owner</div>
          </div>
        </div>

        {/* View profile hint */}
        <div style={{
          marginTop: 10, display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10.5, color: typeColor, fontWeight: 600,
          position: 'relative', zIndex: 1,
        }}>
          <History size={10} /> View Full History
        </div>
      </div>
    </Link>
  );
};

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export const Vehicles: React.FC = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const incomingPlate = (searchParams.get('plate') || '').toUpperCase();

  const [search, setSearch]       = useState(incomingPlate);
  const [deleteId, setDeleteId]   = useState<number | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');
  const [sortKey, setSortKey] = useState<SortKey>('last_visit');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [form, setForm]           = useState({
    plate_number: incomingPlate, make: '', model: '', year: '', color: '',
    vehicle_type: 'sedan', owner_name: '', owner_phone: '', owner_email: '',
  });

  // If a plate arrives from the ANPR / URL, open the add-vehicle form immediately
  // when the vehicle list is loaded and that plate isn't found.
  const { data: vehicles = [], isLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehiclesApi.list().then(r => r.data),
    refetchInterval: 45000,
  });

  const refreshFleet = () => {
    qc.invalidateQueries({ queryKey: ['vehicles'] });
    toast.success('Fleet refreshed');
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => vehiclesApi.create(data),
    onSuccess: (res) => {
      const savedPlate: string = res?.data?.plate_number || form.plate_number;
      qc.invalidateQueries({ queryKey: ['vehicles'] });
      setShowForm(false);
      setForm({ plate_number: '', make: '', model: '', year: '', color: '', vehicle_type: 'sedan', owner_name: '', owner_phone: '', owner_email: '' });
      toast((t) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Vehicle <strong>{savedPlate}</strong> registered.</span>
          <button
            style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
            onClick={() => { toast.dismiss(t.id); navigate(`/visits/new?plate=${encodeURIComponent(savedPlate)}`); }}
          >
            + Open visit
          </button>
        </div>
      ), { duration: 7000 });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => vehiclesApi.delete(id),
    onSuccess: () => { toast.success('Deleted'); setDeleteId(null); qc.invalidateQueries({ queryKey: ['vehicles'] }); },
    onError: () => toast.error('Delete failed'),
  });

  const filtered = useMemo(() => {
    return (vehicles as Vehicle[]).filter(v => {
      const matchSearch = !search
        || v.plate_number?.toLowerCase().includes(search.toLowerCase())
        || v.make?.toLowerCase().includes(search.toLowerCase())
        || v.model?.toLowerCase().includes(search.toLowerCase())
        || v.owner_name?.toLowerCase().includes(search.toLowerCase())
        || v.owner_phone?.includes(search);
      const matchType = typeFilter === 'all' || v.vehicle_type === typeFilter;
      return matchSearch && matchType;
    });
  }, [vehicles, search, typeFilter]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: (vehicles as Vehicle[]).length };
    (vehicles as Vehicle[]).forEach(v => {
      const t = v.vehicle_type || 'other';
      counts[t] = (counts[t] || 0) + 1;
    });
    return counts;
  }, [vehicles]);

  const fleetSummary = useMemo(() => {
    const list = vehicles as Vehicle[];
    const totalVisits = list.reduce((s, v) => s + (v.total_visits ?? 0), 0);
    const returning = list.filter(v => (v.total_visits ?? 0) >= 2).length;
    return { totalVisits, returning };
  }, [vehicles]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(key === 'plate' || key === 'vehicle' || key === 'type' || key === 'owner' ? 'asc' : 'desc');
    }
  };

  const sortedFiltered = useMemo(() => {
    const arr = [...filtered] as Vehicle[];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'plate':
          return dir * (a.plate_number || '').localeCompare(b.plate_number || '');
        case 'vehicle':
          return dir * (`${a.make} ${a.model}`).localeCompare(`${b.make} ${b.model}`);
        case 'type':
          return dir * (a.vehicle_type || '').localeCompare(b.vehicle_type || '');
        case 'owner':
          return dir * (a.owner_name || '').localeCompare(b.owner_name || '');
        case 'visits':
          return dir * ((a.total_visits ?? 0) - (b.total_visits ?? 0));
        case 'last_visit':
        default: {
          const ta = a.last_visit ? new Date(a.last_visit).getTime() : 0;
          const tb = b.last_visit ? new Date(b.last_visit).getTime() : 0;
          return dir * (ta - tb);
        }
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const exportCsv = () => {
    const vArr = sortedFiltered;
    if (!vArr.length) return;
    const headers = ['Plate', 'Make', 'Model', 'Year', 'Color', 'Type', 'Owner', 'Phone', 'Total Visits', 'Last Visit'];
    const rows = vArr.map(v => [
      v.plate_number, v.make || '', v.model || '', v.year || '', v.color || '',
      v.vehicle_type || '', v.owner_name || '', v.owner_phone || '',
      v.total_visits ?? 0, v.last_visit ? fmtQatar(v.last_visit, 'shortDate') : '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `vehicles-${qatarYmd()}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported!');
  };

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

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 14px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: 10, color: 'var(--text-primary)',
    fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
  };

  return (
    <div className="animate-fade-in">
      <style>{`
        @keyframes vehicles-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes vehicles-shimmer { 0%{background-position:0% 50%}100%{background-position:200% 50%} }
      `}</style>

      {/* Hero */}
      <div style={{
        position: 'relative',
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 20,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(16,185,129,0.07) 0%, rgba(59,130,246,0.08) 45%, rgba(139,92,246,0.06) 100%)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(110deg, transparent 40%, rgba(255,255,255,0.03) 50%, transparent 60%)',
          backgroundSize: '200% 100%', animation: 'vehicles-shimmer 9s ease infinite',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', padding: '26px 28px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 54, height: 54, borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(16,185,129,0.35), rgba(59,130,246,0.28))',
                border: '1px solid rgba(52,211,153,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 14px 44px rgba(16,185,129,0.18)',
              }}>
                <Car size={28} color="#d1fae5" />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  <h1 className="page-title" style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Vehicles</h1>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase',
                    padding: '5px 12px', borderRadius: 99,
                    background: 'rgba(16,185,129,0.14)', color: 'var(--text-success)', border: '1px solid rgba(52,211,153,0.35)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', animation: 'vehicles-pulse 2.2s ease infinite' }} />
                    Fleet registry
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 560, lineHeight: 1.65 }}>
                  Every plate tied to visits, revenue, and ANPR. Jump to{' '}
                  <Link to="/" style={{ color: 'var(--text-success)', fontWeight: 700 }}>Dashboard</Link>,{' '}
                  <Link to="/visits" style={{ color: 'var(--text-accent)', fontWeight: 700 }}>Visits</Link>, or{' '}
                  <Link to="/fleet-intelligence" style={{ color: 'var(--text-purple)', fontWeight: 700 }}>Fleet intelligence</Link>, or{' '}
                  <Link to="/analytics" style={{ color: 'var(--text-accent)', fontWeight: 700 }}>Analytics</Link>{' '}
                  for live ops context.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={refreshFleet} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Refresh
              </button>
              <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={sortedFiltered.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Download size={14} /> Export
              </button>
              <Link to="/fleet-intelligence" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                <BarChart2 size={14} /> Fleet intelligence
              </Link>
              <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Plus size={15} /> Add vehicle
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
            {[
              { to: '/', label: 'Dashboard', icon: LayoutDashboard },
              { to: '/visits', label: 'Live visits', icon: Clock },
              { to: '/fleet-intelligence', label: 'Fleet intelligence', icon: BarChart2 },
              { to: '/analytics', label: 'Analytics', icon: TrendingUp },
              { to: '/visionflow', label: 'ANPR & speed', icon: Gauge },
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
                <Icon size={14} color="var(--text-success)" /> {label}
                <ArrowRight size={14} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 22,
      }}>
        {[
          { label: 'Registered', value: (vehicles as Vehicle[]).length, sub: 'In fleet', icon: Car, accent: 'var(--text-accent)' },
          { label: 'Matching filter', value: filtered.length, sub: 'Current results', icon: Search, accent: 'var(--text-accent)' },
          { label: 'Visit touches', value: fleetSummary.totalVisits, sub: 'Σ total_visits', icon: History, accent: '#34d399' },
          { label: 'Returning units', value: fleetSummary.returning, sub: '≥ 2 visits', icon: Users, accent: 'var(--text-purple)' },
        ].map(({ label, value, sub, icon: Icon, accent }) => (
          <div
            key={label}
            className="card"
            style={{
              padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
              border: '1px solid var(--border-light)',
              transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = `0 10px 28px rgba(0,0,0,0.2), 0 0 0 1px ${accent}22`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = '';
              e.currentTarget.style.boxShadow = '';
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: 12,
              background: `${accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${accent}35`,
            }}>
              <Icon size={18} color={accent} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{value}</div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
            </div>
          </div>
        ))}
      </div>

      <div>
          {/* Search + filters */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
            <div className="filter-bar">
              <div className="search-wrap">
                <Search size={14} />
                <input
                  className="input search-input"
                  placeholder="Search plate, make, model, owner name, phone..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              {search && <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')}><X size={12} /></button>}
              <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                {filtered.length} vehicle{filtered.length !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Type filter pills */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {VEHICLE_TYPES.map(t => {
                const col = t === 'all' ? 'var(--text-accent)' : (TYPE_COLORS[t] || '#94a3b8');
                const active = typeFilter === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    style={{
                      padding: '4px 12px', borderRadius: 99, border: `1px solid ${active ? col : 'var(--border)'}`,
                      background: active ? `${col}18` : 'var(--bg-elevated)',
                      color: active ? col : 'var(--text-muted)',
                      fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                      textTransform: 'capitalize',
                    }}
                  >
                    {t === 'all' ? 'All Types' : t} {typeCounts[t] ? `(${typeCounts[t]})` : ''}
                  </button>
                );
              })}
            </div>

            {/* View toggle */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Layout</span>
              <div style={{ display: 'flex', background: 'var(--bg-base)', borderRadius: 10, padding: 4, border: '1px solid var(--border-light)' }}>
                {([
                  { id: 'table' as const, icon: List, label: 'Table' },
                  { id: 'grid' as const, icon: LayoutGrid, label: 'Cards' },
                ]).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setViewMode(id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      fontSize: 11.5, fontWeight: 700,
                      background: viewMode === id ? 'var(--bg-elevated)' : 'transparent',
                      color: viewMode === id ? 'var(--text-primary)' : 'var(--text-muted)',
                      boxShadow: viewMode === id ? '0 1px 6px rgba(0,0,0,0.08)' : 'none',
                    }}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Fleet table / grid */}
          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
              <div className="spinner" style={{ width: 32, height: 32 }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="card">
              {search && typeFilter === 'all' ? (
                /* ── Plate not found — offer instant register ── */
                <div style={{ padding: '32px 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }}>
                  <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ScanLine size={26} color="#f59e0b" />
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8, letterSpacing: '-0.2px' }}>
                      Plate <span style={{ color: '#f59e0b', letterSpacing: '0.1em' }}>{search.toUpperCase()}</span> not found
                    </div>
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 400 }}>
                      This plate isn't registered in CarTrack yet. Register the vehicle now and optionally open a visit for it.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                      className="btn btn-primary"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '10px 22px' }}
                      onClick={() => { setForm(f => ({ ...f, plate_number: search.toUpperCase() })); setShowForm(true); }}
                    >
                      <Plus size={14} /> Register vehicle
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '10px 20px' }}
                      onClick={() => navigate(`/visits/new?plate=${encodeURIComponent(search.toUpperCase())}`)}
                    >
                      <ArrowRight size={14} /> Register &amp; new visit
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ScanLine size={11} /> Detected by ANPR? Use <Link to="/visionflow" style={{ color: 'var(--blue)', textDecoration: 'none' }}>ANPR &amp; Speed</Link> to link video detections.
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <Car size={40} />
                  <h3>{typeFilter !== 'all' ? 'No vehicles match' : 'No vehicles yet'}</h3>
                  <p>{typeFilter !== 'all' ? `No ${typeFilter} vehicles found` : 'Add your first vehicle to get started'}</p>
                  <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowForm(true)}>
                    <Plus size={14} /> Add Vehicle
                  </button>
                </div>
              )}
            </div>
          ) : viewMode === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(265px, 1fr))', gap: 14 }}>
              {sortedFiltered.map((vehicle: Vehicle) => (
                <VehicleCard
                  key={vehicle.id}
                  vehicle={vehicle}
                  onDelete={() => setDeleteId(vehicle.id)}
                />
              ))}
            </div>
          ) : (
            <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)', padding: 0 }}>
              <div style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-light)',
                background: 'var(--bg-elevated)',
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Layers size={16} color="#34d399" />
                    Fleet registry
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                    Click a row to expand details · Sort by column headers
                  </div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
                  {sortedFiltered.length} vehicle{sortedFiltered.length !== 1 ? 's' : ''}
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                      <th style={{ ...thStyle, width: 44, paddingLeft: 16 }} />
                      {sortTh('plate', 'Plate')}
                      {sortTh('vehicle', 'Vehicle')}
                      {sortTh('type', 'Type')}
                      <th style={thStyle}>Color</th>
                      {sortTh('owner', 'Owner')}
                      {sortTh('visits', 'Visits', 'right')}
                      {sortTh('last_visit', 'Last visit')}
                      <th style={{ ...thStyle, textAlign: 'right', paddingRight: 18, width: 108 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedFiltered.map((v: Vehicle, rowIdx: number) => {
                      const tc = TYPE_COLORS[v.vehicle_type || 'other'] || '#94a3b8';
                      const isOpen = expandedId === v.id;
                      const colorDot = COLOR_DOTS[v.color?.toLowerCase() || ''];
                      const visits = v.total_visits ?? 0;
                      return (
                        <React.Fragment key={v.id}>
                          <tr
                            onClick={() => setExpandedId(isOpen ? null : v.id)}
                            style={{
                              cursor: 'pointer',
                              background: isOpen
                                ? 'rgba(16,185,129,0.06)'
                                : rowIdx % 2 === 1
                                  ? 'rgba(16,185,129,0.02)'
                                  : 'transparent',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                            onMouseLeave={e => {
                              if (!isOpen) {
                                e.currentTarget.style.background = rowIdx % 2 === 1 ? 'rgba(16,185,129,0.02)' : 'transparent';
                              }
                            }}
                          >
                            <td style={{ ...tdStyle, paddingLeft: 16, width: 44 }}>
                              <span style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 26, height: 26, borderRadius: 8,
                                background: isOpen ? 'rgba(16,185,129,0.12)' : 'var(--bg-base)',
                                border: '1px solid var(--border-light)',
                                transition: 'transform 0.2s',
                                transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                              }}>
                                <ChevronDown size={14} color={isOpen ? '#059669' : 'var(--text-muted)'} />
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <span style={{
                                fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 13,
                                color: 'var(--text-accent)', background: 'rgba(59,130,246,0.08)',
                                padding: '4px 10px', borderRadius: 8, letterSpacing: '0.06em',
                              }}>{v.plate_number}</span>
                            </td>
                            <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--text-primary)', minWidth: 160 }}>
                              <div>{v.make || 'Unknown'}{v.model ? ` ${v.model}` : ''}</div>
                              {v.year && <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginTop: 3 }}>{v.year}</div>}
                            </td>
                            <td style={tdStyle}>
                              {v.vehicle_type ? (
                                <span style={{
                                  fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
                                  padding: '4px 10px', borderRadius: 99, background: `${tc}18`, color: tc,
                                  border: `1px solid ${tc}30`,
                                }}>{v.vehicle_type}</span>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={tdStyle}>
                              {v.color ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textTransform: 'capitalize', fontSize: 12.5 }}>
                                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: colorDot || v.color, border: '1px solid var(--border-light)' }} />
                                  {v.color}
                                </span>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, maxWidth: 180 }}>
                              {v.owner_name ? (
                                <div>
                                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 12.5 }}>{v.owner_name}</div>
                                  {v.owner_phone && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{v.owner_phone}</div>}
                                </div>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              <span style={{
                                fontWeight: 800, fontSize: 15, fontVariantNumeric: 'tabular-nums',
                                color: visits >= 2 ? '#059669' : visits === 1 ? 'var(--text-accent)' : 'var(--text-muted)',
                              }}>{visits}</span>
                              {visits >= 2 && (
                                <div style={{ fontSize: 9, fontWeight: 700, color: '#059669', marginTop: 2 }}>Returning</div>
                              )}
                            </td>
                            <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {v.last_visit ? fmtQatar(v.last_visit, 'medDate') : <span style={{ color: 'var(--text-muted)' }}>Never</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 18 }} onClick={e => e.stopPropagation()}>
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                <button type="button" className="btn btn-ghost btn-icon" title="Profile" onClick={() => navigate(`/vehicles/${v.id}`)}>
                                  <Eye size={13} />
                                </button>
                                <Link to={`/visits/new?plate=${encodeURIComponent(v.plate_number)}`} className="btn btn-ghost btn-icon" title="New visit" onClick={e => e.stopPropagation()}>
                                  <Plus size={13} />
                                </Link>
                                <button type="button" className="btn btn-danger btn-icon" title="Delete" onClick={() => setDeleteId(v.id)}>
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={9} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                                <VehicleExpandPanel vehicle={v} onDelete={() => setDeleteId(v.id)} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--border-light)',
                background: 'var(--bg-elevated)',
                fontSize: 12, color: 'var(--text-muted)', fontWeight: 600,
                display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
              }}>
                <span>Showing <strong style={{ color: 'var(--text-primary)' }}>{sortedFiltered.length}</strong> of {(vehicles as Vehicle[]).length} registered</span>
                <span>{fleetSummary.returning} returning customers (≥2 visits)</span>
              </div>
            </div>
          )}
      </div>

      {/* Add Vehicle Modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal-box" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Add Vehicle</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowForm(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[
                  { label: 'Plate Number *', key: 'plate_number', mono: true, span: false },
                  { label: 'Vehicle Type', key: 'vehicle_type', type: 'select', opts: ['sedan','suv','truck','van','motorcycle','other'], span: false },
                  { label: 'Make', key: 'make', placeholder: 'Toyota', span: false },
                  { label: 'Model', key: 'model', placeholder: 'Camry', span: false },
                  { label: 'Year', key: 'year', type: 'number', placeholder: '2024', span: false },
                  { label: 'Color', key: 'color', placeholder: 'White', span: false },
                  { label: 'Owner Name', key: 'owner_name', span: false },
                  { label: 'Owner Phone', key: 'owner_phone', placeholder: '+974 xxxx xxxx', span: false },
                ].map(({ label, key, type, mono, opts, placeholder }) => (
                  <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="label">{label}</label>
                    {type === 'select' ? (
                      <select style={inputStyle} value={(form as any)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}>
                        {(opts||[]).map(o => <option key={o} value={o} style={{ textTransform: 'capitalize' }}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        style={{ ...inputStyle, ...(mono ? { fontFamily: 'monospace', fontWeight: 800, letterSpacing: 2, fontSize: 16 } : {}) }}
                        type={type || 'text'}
                        placeholder={placeholder}
                        value={(form as any)[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => createMutation.mutate({ ...form, year: form.year ? parseInt(form.year) : undefined })}
                disabled={!form.plate_number || createMutation.isPending}
              >
                {createMutation.isPending ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : <><Plus size={13} /> Add Vehicle</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {deleteId !== null && (
        <div className="modal-backdrop" onClick={() => setDeleteId(null)}>
          <div className="modal-box" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Delete Vehicle?</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setDeleteId(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                This will permanently delete the vehicle and its visit history.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteId(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => deleteId && deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
