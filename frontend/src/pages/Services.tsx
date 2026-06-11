import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Wrench, X, Edit, Trash2, Clock, DollarSign,
  Search, BarChart2, Tag, AlertTriangle, CheckCircle,
  ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, Layers, Sparkles,
} from 'lucide-react';
import { servicesApi } from '../services/api';
import toast from 'react-hot-toast';
import { fmtQatar } from '../lib/qatarTime';
import type { Service, ServiceCategory } from '../types';

const CATEGORIES: { value: ServiceCategory; label: string; icon: string; color: string; bg: string; accent: string }[] = [
  { value: 'wash',        label: 'Wash',        icon: '🚿', color: 'var(--text-accent)', bg: 'rgba(37,99,235,0.1)',   accent: '#3b82f6' },
  { value: 'detailing',   label: 'Detailing',   icon: '✨', color: 'var(--text-purple)', bg: 'rgba(139,92,246,0.1)',  accent: '#8b5cf6' },
  { value: 'polish',      label: 'Polish',      icon: '💎', color: '#f9a8d4', bg: 'rgba(236,72,153,0.1)',  accent: '#ec4899' },
  { value: 'repair',      label: 'Repair',      icon: '🔧', color: 'var(--text-danger)', bg: 'rgba(239,68,68,0.1)',   accent: '#ef4444' },
  { value: 'maintenance', label: 'Maintenance', icon: '⚙️', color: 'var(--text-warning)', bg: 'rgba(245,158,11,0.1)',  accent: '#f59e0b' },
  { value: 'inspection',  label: 'Inspection',  icon: '🔍', color: 'var(--text-cyan)', bg: 'rgba(6,182,212,0.1)',   accent: '#06b6d4' },
  { value: 'other',       label: 'Other',       icon: '📋', color: '#9ca3af', bg: 'rgba(75,85,99,0.1)',    accent: '#6b7280' },
];

const EMPTY_FORM = {
  name: '', description: '', category: 'wash' as ServiceCategory,
  base_price: '',
};

const durationSourceLabel = (svc: Service): string => {
  if (svc.is_auto_calculated && (svc.duration_job_count ?? 0) > 0) {
    const n = svc.duration_job_count ?? 0;
    return `Auto · ${n} signed work order${n !== 1 ? 's' : ''}`;
  }
  if (svc.duration_source === 'category_default') return 'Category default until first sign-off';
  return 'Updates after supervisor sign-off';
};

type SortKey = 'name' | 'category' | 'price' | 'duration' | 'status';
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

const ServiceDetailPanel: React.FC<{
  svc: Service;
  cfg: typeof CATEGORIES[number];
  onEdit: () => void;
  onDelete: () => void;
}> = ({ svc, cfg, onEdit, onDelete }) => (
  <div className="expand-panel" style={{
    background: 'linear-gradient(180deg, rgba(59,130,246,0.04) 0%, var(--bg-base) 100%)',
    borderTop: '1px solid var(--border-light)',
  }}>
    <div className="rcols-1-auto" style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 8 }}>
          Description
        </div>
        <p style={{
          margin: 0, fontSize: 13.5, lineHeight: 1.65, color: svc.description ? 'var(--text-primary)' : 'var(--text-muted)',
          maxWidth: 640,
        }}>
          {svc.description || 'No description provided for this service.'}
        </p>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 18,
          paddingTop: 16, borderTop: '1px solid var(--border-light)',
        }}>
          {[
            { label: 'Service ID', value: `#${svc.id}` },
            { label: 'Category', value: `${cfg.icon} ${cfg.label}` },
            { label: 'Added', value: svc.created_at ? fmtQatar(svc.created_at, 'medDate') : '—' },
            { label: 'Est. duration', value: svc.estimated_duration_minutes ? `${svc.estimated_duration_minutes} min` : 'Pending' },
            { label: 'Duration basis', value: durationSourceLabel(svc) },
            { label: 'Base price', value: `QAR ${svc.base_price.toLocaleString()}` },
          ].map(item => (
            <div key={item.label}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {item.label}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={e => { e.stopPropagation(); onEdit(); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Edit size={13} /> Edit
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </div>
  </div>
);

export const Services: React.FC = () => {
  const qc = useQueryClient();
  const [catFilter, setCatFilter] = useState<ServiceCategory | ''>('');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editSvc, setEditSvc] = useState<Service | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('category');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const { data: services = [], isLoading } = useQuery({
    queryKey: ['services'],
    queryFn: () => servicesApi.list().then(r => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => editSvc ? servicesApi.update(editSvc.id, data) : servicesApi.create(data),
    onSuccess: () => {
      toast.success(editSvc ? 'Service updated!' : 'Service added!');
      qc.invalidateQueries({ queryKey: ['services'] });
      setShowForm(false); setEditSvc(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Failed to save service'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => servicesApi.delete(id),
    onSuccess: () => { toast.success('Service deleted'); setDeleteId(null); setExpandedId(null); qc.invalidateQueries({ queryKey: ['services'] }); },
    onError: () => toast.error('Delete failed'),
  });

  const openEdit = (svc: Service) => {
    setEditSvc(svc);
    setForm({
      name: svc.name, description: svc.description || '',
      category: svc.category,
      base_price: String(svc.base_price),
    });
    setShowForm(true);
  };

  const filtered = useMemo(() => (services as Service[]).filter(s =>
    (!catFilter || s.category === catFilter) &&
    (!search || s.name.toLowerCase().includes(search.toLowerCase()) || (s.description || '').toLowerCase().includes(search.toLowerCase()))
  ), [services, catFilter, search]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'price' || key === 'duration' ? 'desc' : 'asc'); }
  };

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'category':
          return dir * (a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
        case 'price':
          return dir * (a.base_price - b.base_price);
        case 'duration':
          return dir * ((a.estimated_duration_minutes || 0) - (b.estimated_duration_minutes || 0));
        case 'status':
          return dir * (Number(a.is_active !== false) - Number(b.is_active !== false));
        default:
          return 0;
      }
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const maxDuration = useMemo(() =>
    Math.max(...sorted.map(s => s.estimated_duration_minutes || 0), 1),
  [sorted]);

  const summaryStats = useMemo(() => {
    const all = services as Service[];
    const totalRevPotential = all.reduce((s, sv) => s + sv.base_price, 0);
    const avgPrice = all.length > 0 ? totalRevPotential / all.length : 0;
    const withDur = all.filter(s => s.estimated_duration_minutes);
    const avgDuration = withDur.length > 0
      ? withDur.reduce((s, sv) => s + (sv.estimated_duration_minutes || 0), 0) / withDur.length
      : 0;
    const categories = new Set(all.map(s => s.category)).size;
    return { total: all.length, totalRevPotential, avgPrice, avgDuration: Math.round(avgDuration), categories };
  }, [services]);

  const catCfg = (cat: string) => CATEGORIES.find(c => c.value === cat) || CATEGORIES[6];

  const inputStyle = {
    width: '100%', padding: '9px 14px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: 10, color: 'var(--text-primary)',
    fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box' as const,
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

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Services</h1>
          <p className="page-desc">Service catalog — pricing, duration estimates, and categories</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setEditSvc(null); setForm(EMPTY_FORM); setShowForm(true); }}
          style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', boxShadow: '0 4px 14px rgba(59,130,246,0.35)' }}
        >
          <Plus size={15} /> Add Service
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Total Services', value: summaryStats.total, icon: Tag, color: 'var(--text-accent)', bg: 'rgba(96,165,250,0.12)' },
          { label: 'Avg Service Price', value: `QAR ${summaryStats.avgPrice.toFixed(0)}`, icon: DollarSign, color: 'var(--text-purple)', bg: 'rgba(196,181,253,0.12)' },
          { label: 'Avg Duration', value: summaryStats.avgDuration > 0 ? `${summaryStats.avgDuration}m` : '—', icon: Clock, color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)' },
          { label: 'Categories', value: summaryStats.categories, icon: BarChart2, color: 'var(--text-success)', bg: 'rgba(110,231,183,0.12)' },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
            borderRadius: 14, padding: '18px 20px',
            display: 'flex', alignItems: 'center', gap: 14,
            boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: 12, background: s.bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <s.icon size={20} color={s.color} />
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Category pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          onClick={() => setCatFilter('')}
          style={{
            padding: '6px 16px', borderRadius: 99, fontSize: 12.5, fontWeight: 600,
            cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.15s',
            background: catFilter === '' ? 'rgba(37,99,235,0.15)' : 'var(--bg-elevated)',
            color: catFilter === '' ? 'var(--text-accent)' : 'var(--text-secondary)',
            borderColor: catFilter === '' ? 'rgba(59,130,246,0.3)' : 'var(--border-light)',
          }}
        >
          All ({(services as Service[]).length})
        </button>
        {CATEGORIES.map(cat => {
          const count = (services as Service[]).filter(s => s.category === cat.value).length;
          if (count === 0) return null;
          return (
            <button
              key={cat.value}
              onClick={() => setCatFilter(catFilter === cat.value ? '' : cat.value)}
              style={{
                padding: '6px 16px', borderRadius: 99, fontSize: 12.5, fontWeight: 600,
                cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.15s',
                background: catFilter === cat.value ? cat.bg : 'var(--bg-elevated)',
                color: catFilter === cat.value ? cat.color : 'var(--text-secondary)',
                borderColor: catFilter === cat.value ? `${cat.color}40` : 'var(--border-light)',
              }}
            >
              {cat.icon} {cat.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Search + table card */}
      <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)', padding: 0 }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-elevated)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Layers size={16} color="var(--text-accent)" />
              Service catalog
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
              Click a row to expand details · Sort by column headers
            </div>
          </div>
          <div className="search-wrap" style={{ flex: '0 1 280px', minWidth: 200 }}>
            <Search size={14} />
            <input
              className="input search-input"
              placeholder="Search name or description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {search && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')}>
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 80, flexDirection: 'column', gap: 12 }}>
            <div className="spinner" style={{ width: 36, height: 36 }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading services...</span>
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: 56, textAlign: 'center' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', background: 'rgba(139,92,246,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <Wrench size={30} color="var(--text-purple)" />
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>No services found</h3>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>
              {search || catFilter ? 'Try adjusting your filters' : 'Add services to build your catalog'}
            </p>
            {!search && !catFilter && (
              <button
                className="btn btn-primary" style={{ marginTop: 20 }}
                onClick={() => { setEditSvc(null); setForm(EMPTY_FORM); setShowForm(true); }}
              >
                <Plus size={14} /> Add First Service
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                    <th style={{ ...thStyle, width: 44, paddingLeft: 16 }} />
                    {sortTh('name', 'Service')}
                    {sortTh('category', 'Category')}
                    <th style={thStyle}>Description</th>
                    {sortTh('duration', 'Duration', 'right')}
                    {sortTh('price', 'Price', 'right')}
                    {sortTh('status', 'Status')}
                    <th style={{ ...thStyle, textAlign: 'right', paddingRight: 18, width: 100 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((svc, rowIdx) => {
                    const cfg = catCfg(svc.category);
                    const isOpen = expandedId === svc.id;
                    const dur = svc.estimated_duration_minutes || 0;
                    const durPct = dur > 0 ? Math.min(100, (dur / maxDuration) * 100) : 0;
                    const active = svc.is_active !== false;

                    return (
                      <React.Fragment key={svc.id}>
                        <tr
                          onClick={() => setExpandedId(isOpen ? null : svc.id)}
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
                            if (!isOpen) {
                              e.currentTarget.style.background = rowIdx % 2 === 1 ? 'rgba(59,130,246,0.02)' : 'transparent';
                            }
                          }}
                        >
                          <td style={{ ...tdStyle, paddingLeft: 16, width: 44 }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 26, height: 26, borderRadius: 8,
                              background: isOpen ? 'rgba(59,130,246,0.12)' : 'var(--bg-base)',
                              border: '1px solid var(--border-light)',
                              transition: 'transform 0.2s',
                              transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                            }}>
                              <ChevronDown size={14} color={isOpen ? 'var(--text-accent)' : 'var(--text-muted)'} />
                            </span>
                          </td>
                          <td style={{ ...tdStyle, fontWeight: 800, color: 'var(--text-primary)', minWidth: 180 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{
                                width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                                background: cfg.bg, border: `1px solid ${cfg.accent}28`,
                                display: 'grid', placeItems: 'center', fontSize: 16,
                              }}>
                                {cfg.icon}
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ lineHeight: 1.3 }}>{svc.name}</div>
                                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginTop: 3 }}>ID #{svc.id}</div>
                              </div>
                            </div>
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              fontSize: 11, fontWeight: 800, textTransform: 'capitalize',
                              padding: '4px 10px', borderRadius: 99,
                              background: cfg.bg, color: cfg.color,
                              border: `1px solid ${cfg.accent}30`,
                            }}>
                              {cfg.label}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, maxWidth: 280 }}>
                            <div style={{
                              fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45,
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            }} title={svc.description || undefined}>
                              {svc.description || <span style={{ fontStyle: 'italic' }}>No description</span>}
                            </div>
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', minWidth: 120 }}>
                            {dur > 0 ? (
                              <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 88 }}>
                                <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                                  {dur}m
                                </span>
                                <div style={{
                                  width: 72, height: 4, borderRadius: 99,
                                  background: 'var(--border-light)', overflow: 'hidden',
                                }}>
                                  <div style={{
                                    width: `${durPct}%`, height: '100%', borderRadius: 99,
                                    background: `linear-gradient(90deg, ${cfg.accent}88, ${cfg.accent})`,
                                  }} />
                                </div>
                                <span style={{
                                  fontSize: 9, fontWeight: 700, color: svc.is_auto_calculated ? '#059669' : 'var(--text-muted)',
                                  display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 120, textAlign: 'right', lineHeight: 1.3,
                                }}>
                                  {svc.is_auto_calculated && <Sparkles size={9} />}
                                  {durationSourceLabel(svc)}
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Pending</span>
                            )}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, fontSize: 15, color: '#059669', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            QAR {svc.base_price.toLocaleString()}
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              fontSize: 11, fontWeight: 700,
                              padding: '4px 10px', borderRadius: 99,
                              background: active ? 'rgba(16,185,129,0.1)' : 'rgba(100,116,139,0.08)',
                              color: active ? '#059669' : 'var(--text-muted)',
                              border: `1px solid ${active ? 'rgba(16,185,129,0.25)' : 'var(--border-light)'}`,
                            }}>
                              <span style={{
                                width: 6, height: 6, borderRadius: '50%',
                                background: active ? '#10b981' : '#94a3b8',
                                boxShadow: active ? '0 0 6px rgba(16,185,129,0.5)' : 'none',
                              }} />
                              {active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', paddingRight: 18 }}>
                            <div style={{ display: 'inline-flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                              <button className="btn btn-ghost btn-icon" onClick={() => openEdit(svc)} title="Edit">
                                <Edit size={13} />
                              </button>
                              <button className="btn btn-danger btn-icon" onClick={() => setDeleteId(svc.id)} title="Delete">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={8} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                              <ServiceDetailPanel
                                svc={svc}
                                cfg={cfg}
                                onEdit={() => openEdit(svc)}
                                onDelete={() => setDeleteId(svc.id)}
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

            <div style={{
              padding: '12px 20px',
              borderTop: '1px solid var(--border-light)',
              background: 'var(--bg-elevated)',
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              fontSize: 12, color: 'var(--text-muted)', fontWeight: 600,
            }}>
              <span>
                Showing <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong>
                {sorted.length !== (services as Service[]).length && (
                  <> of <strong style={{ color: 'var(--text-primary)' }}>{(services as Service[]).length}</strong></>
                )} services
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                Catalog value: QAR {sorted.reduce((s, sv) => s + sv.base_price, 0).toLocaleString()}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => { setShowForm(false); setEditSvc(null); }}>
          <div className="modal-box" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Wrench size={16} color="var(--text-purple)" />
                {editSvc ? 'Edit Service' : 'New Service'}
              </h2>
              <button className="btn btn-ghost btn-icon" onClick={() => { setShowForm(false); setEditSvc(null); }}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="label">Service Name *</label>
                <input
                  style={inputStyle}
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Full Body Wash"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label">Category</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, category: cat.value }))}
                      style={{
                        padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                        cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.15s',
                        background: form.category === cat.value ? cat.bg : 'var(--bg-elevated)',
                        color: form.category === cat.value ? cat.color : 'var(--text-secondary)',
                        borderColor: form.category === cat.value ? `${cat.color}40` : 'var(--border)',
                      }}
                    >
                      {cat.icon} {cat.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{
                padding: '12px 14px', borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.06), rgba(16,185,129,0.05))',
                border: '1px solid rgba(59,130,246,0.15)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <Sparkles size={16} color="var(--text-accent)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>Estimated duration is automatic</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.55 }}>
                      Calculated from the average time between shop entry and supervisor sign-off on completed work orders.
                      {editSvc && (
                        <span style={{ display: 'block', marginTop: 6, fontWeight: 700, color: '#059669' }}>
                          Current: {editSvc.estimated_duration_minutes}m · {durationSourceLabel(editSvc)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="label">Price (QAR) *</label>
                <input
                  style={inputStyle} type="number" min="0"
                  value={form.base_price}
                  onChange={e => setForm(f => ({ ...f, base_price: e.target.value }))}
                  placeholder="100"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="label">Description</label>
                <textarea
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Brief description of what's included..."
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setShowForm(false); setEditSvc(null); }}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => createMutation.mutate({
                  ...form,
                  base_price: parseFloat(form.base_price),
                })}
                disabled={!form.name || !form.base_price || createMutation.isPending}
              >
                {createMutation.isPending
                  ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Saving...</>
                  : editSvc ? <><CheckCircle size={14} /> Update Service</> : <><Plus size={14} /> Add Service</>}
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
              <h2 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={16} color="#ef4444" /> Delete Service?
              </h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setDeleteId(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                This will permanently remove the service from the catalog. Existing visit records using this service will not be affected.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteId(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => deleteId && deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 size={13} /> Delete Service
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
