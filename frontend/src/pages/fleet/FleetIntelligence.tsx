import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart2, Car, Clock, Layers, Sparkles, TrendingUp,
  ArrowRight, RefreshCw, Download, Gauge, Wrench, Target,
  ChevronRight, ChevronDown, ExternalLink,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, ComposedChart, Line,
} from 'recharts';
import { analyticsApi } from '../../services/api';
import { qatarYmd, fmtQatar } from '../../lib/qatarTime';
import toast from 'react-hot-toast';

const SEDAN = '#3b82f6';
const SUV = '#10b981';

const TYPE_COLORS: Record<string, string> = {
  sedan: SEDAN,
  suv: SUV,
  truck: '#f97316',
  van: '#8b5cf6',
  motorcycle: '#ec4899',
  other: '#64748b',
  unknown: '#94a3b8',
};

const PERIODS = [30, 90, 180, 365] as const;
const BODY_TYPES = ['sedan', 'suv'] as const;

type TabId = 'service' | 'type' | 'model';

interface TypeRow {
  vehicle_type: string;
  count: number;
  avg_duration_minutes: number;
  total_revenue: number;
  avg_revenue: number;
}

interface ModelRow {
  label: string;
  make: string;
  model: string;
  vehicle_type: string;
  count: number;
  avg_duration_minutes: number;
  avg_revenue: number;
  total_revenue: number;
  avg_services: number;
}

interface TypeDurationCell {
  vehicle_type: string;
  count: number;
  avg_minutes: number | null;
  measured_count: number;
  inferred_count: number;
  data_quality: string;
  total_revenue: number;
}

interface ServiceByTypeRow {
  service_name: string;
  category: string;
  estimated_duration: number;
  total_jobs: number;
  total_revenue: number;
  by_type: Record<string, TypeDurationCell>;
  suv_vs_sedan_delta_minutes: number | null;
}

const fmtMin = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (v >= 60) {
    const h = Math.floor(v / 60);
    const m = Math.round(v % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(v)} min`;
};

const fmtMinShort = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return '—';
  return v >= 60 ? `${(v / 60).toFixed(1)}h` : `${Math.round(v)}m`;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const deltaPhrase = (delta: number | null, sedan: number | null, suv: number | null): string => {
  if (delta == null || sedan == null || suv == null) {
    if (sedan != null && suv == null) return 'SUV data not available yet for this service';
    if (suv != null && sedan == null) return 'Sedan data not available yet for this service';
    return 'Not enough timing data for both body types';
  }
  if (Math.abs(delta) < 3) return 'SUV and Sedan take about the same time';
  if (delta > 0) return `SUV takes ${fmtMinShort(delta)} longer than Sedan on average`;
  return `Sedan takes ${fmtMinShort(Math.abs(delta))} longer than SUV on average`;
};

interface ChartRow {
  fullName: string;
  shortName: string;
  sedan: number;
  suv: number;
  sedanDisplay: number;
  suvDisplay: number;
  sedanOutlier: boolean;
  suvOutlier: boolean;
  sedanCount: number;
  suvCount: number;
  delta: number | null;
  totalJobs: number;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 120;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function buildChartRows(rows: ServiceByTypeRow[], limit = 10): { data: ChartRow[]; scaleMax: number; hasOutliers: boolean } {
  const mapped = rows
    .filter(r => (r.by_type.sedan?.avg_minutes ?? 0) > 0 || (r.by_type.suv?.avg_minutes ?? 0) > 0)
    .map(r => {
      const sedan = r.by_type.sedan?.avg_minutes ?? 0;
      const suv = r.by_type.suv?.avg_minutes ?? 0;
      return {
        fullName: r.service_name,
        shortName: r.service_name,
        sedan,
        suv,
        sedanDisplay: sedan,
        suvDisplay: suv,
        sedanOutlier: false,
        suvOutlier: false,
        sedanCount: r.by_type.sedan?.count ?? 0,
        suvCount: r.by_type.suv?.count ?? 0,
        delta: r.suv_vs_sedan_delta_minutes,
        totalJobs: r.total_jobs,
      };
    })
    .sort((a, b) => Math.max(b.sedan, b.suv) - Math.max(a.sedan, a.suv))
    .slice(0, limit);

  const allPositive = mapped.flatMap(r => [r.sedan, r.suv].filter(v => v > 0));
  const rawMax = Math.max(...allPositive, 1);
  const p90 = percentile(allPositive, 0.9);
  const scaleMax = rawMax > p90 * 1.35
    ? Math.max(60, Math.ceil((p90 * 1.12) / 15) * 15)
    : Math.ceil(rawMax * 1.08 / 15) * 15;

  const hasOutliers = mapped.some(r => r.sedan > scaleMax || r.suv > scaleMax);
  const data = mapped.map(r => ({
    ...r,
    sedanDisplay: r.sedan > scaleMax ? scaleMax : r.sedan,
    suvDisplay: r.suv > scaleMax ? scaleMax : r.suv,
    sedanOutlier: r.sedan > scaleMax,
    suvOutlier: r.suv > scaleMax,
  }));

  return { data, scaleMax, hasOutliers };
}

const ChartTooltipPanel: React.FC<{ row: ChartRow; scaleMax: number }> = ({ row, scaleMax }) => (
  <div style={{
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: '14px 16px',
    boxShadow: '0 16px 48px rgba(15,23,42,0.12)',
    minWidth: 240,
  }}>
    <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10, lineHeight: 1.35 }}>
      {row.fullName}
    </div>
    {[
      { label: 'Sedan', val: row.sedan, count: row.sedanCount, color: SEDAN, outlier: row.sedanOutlier },
      { label: 'SUV', val: row.suv, count: row.suvCount, color: SUV, outlier: row.suvOutlier },
    ].map(item => (
      <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', width: 48 }}>{item.label}</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>
          {fmtMin(item.val)}
          {item.outlier && <span style={{ fontSize: 10, color: '#ea580c', marginLeft: 4 }}>above scale</span>}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>×{item.count}</span>
      </div>
    ))}
    {row.delta != null && (
      <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border-light)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
        {deltaPhrase(row.delta, row.sedan || null, row.suv || null)}
      </div>
    )}
    {scaleMax > 0 && (row.sedan > scaleMax || row.suv > scaleMax) && (
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
        Chart scale ends at {scaleMax}m — values marked + are longer
      </div>
    )}
  </div>
);

const ServiceDurationChart: React.FC<{ rows: ServiceByTypeRow[]; days: number }> = ({ rows, days }) => {
  const { data, scaleMax, hasOutliers } = useMemo(() => buildChartRows(rows, 10), [rows]);
  const [hovered, setHovered] = useState<number | null>(null);

  const xTicks = useMemo(() => {
    const step = scaleMax <= 120 ? 30 : scaleMax <= 240 ? 60 : scaleMax <= 480 ? 120 : 180;
    const ticks: number[] = [];
    for (let t = 0; t <= scaleMax; t += step) ticks.push(t);
    if (ticks[ticks.length - 1] !== scaleMax) ticks.push(scaleMax);
    return ticks;
  }, [scaleMax]);

  const summary = useMemo(() => {
    let sT = 0; let sC = 0; let uT = 0; let uC = 0;
    data.forEach(r => {
      if (r.sedan > 0) { sT += r.sedan * r.sedanCount; sC += r.sedanCount; }
      if (r.suv > 0) { uT += r.suv * r.suvCount; uC += r.suvCount; }
    });
    return {
      sedanAvg: sC ? sT / sC : null,
      suvAvg: uC ? uT / uC : null,
    };
  }, [data]);

  if (data.length === 0) return null;

  const barPct = (v: number) => Math.min(100, Math.max(0, (v / scaleMax) * 100));

  return (
    <div style={{
      borderRadius: 20,
      overflow: 'hidden',
      border: '1px solid var(--border-light)',
      background: 'var(--bg-surface)',
      boxShadow: '0 4px 24px rgba(15,23,42,0.06)',
    }}>
      <style>{`
        @keyframes fi-bar-in { from { width: 0; opacity: 0.4; } to { opacity: 1; } }
        .fi-chart-row { transition: background 0.18s ease; }
        .fi-chart-row:hover { background: rgba(59,130,246,0.04); }
        .fi-bar-fill { animation: fi-bar-in 0.55s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '22px 26px 18px',
        borderBottom: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(16,185,129,0.04) 100%)',
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-accent)', marginBottom: 8 }}>
              Duration benchmark
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.035em', lineHeight: 1.2 }}>
              Service time — SUV vs Sedan
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
              Top {data.length} services · last {days} days · minutes per job
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: 'Sedan avg', value: fmtMinShort(summary.sedanAvg), color: SEDAN, sub: 'weighted' },
              { label: 'SUV avg', value: fmtMinShort(summary.suvAvg), color: SUV, sub: 'weighted' },
            ].map(k => (
              <div key={k.label} style={{
                padding: '10px 16px', borderRadius: 12, minWidth: 100,
                background: 'var(--bg-surface)', border: `1px solid ${k.color}28`,
                boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k.label}</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: k.color, marginTop: 4, letterSpacing: '-0.02em' }}>{k.value}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{k.sub}</div>
              </div>
            ))}
          </div>
        </div>
        {hasOutliers && (
          <div style={{
            marginTop: 14, fontSize: 11.5, color: '#92400e',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderRadius: 10,
            background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.25)',
          }}>
            <span style={{ fontWeight: 800 }}>Scale note</span>
            Axis capped at {scaleMax}m — dashed bars show values beyond scale; hover for exact duration
          </div>
        )}
      </div>

      {/* Chart body */}
      <div style={{ padding: '20px 24px 24px' }}>
        {/* Column headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 22%) 1fr minmax(72px, 88px)',
          gap: 16,
          marginBottom: 12,
          paddingBottom: 10,
          borderBottom: '2px solid var(--border-light)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Service</div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingLeft: 2, paddingRight: 2 }}>
              {xTicks.map(t => (
                <span key={t} style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {t >= 60 ? `${(t / 60).toFixed(t % 60 === 0 ? 0 : 1)}h` : `${t}m`}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 4, borderRadius: 2, background: 'linear-gradient(90deg, #93c5fd, #2563eb)' }} /> Sedan
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 4, borderRadius: 2, background: 'linear-gradient(90deg, #6ee7b7, #059669)' }} /> SUV
              </span>
            </div>
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' }}>Gap</div>
        </div>

        {/* Rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {data.map((row, idx) => {
            const isHover = hovered === idx;
            const delta = row.delta;
            return (
              <div
                key={row.fullName}
                className="fi-chart-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(140px, 22%) 1fr minmax(72px, 88px)',
                  gap: 16,
                  alignItems: 'center',
                  padding: '12px 8px',
                  borderRadius: 12,
                  position: 'relative',
                  background: isHover ? 'rgba(59,130,246,0.05)' : idx % 2 === 1 ? 'var(--bg-base)' : 'transparent',
                  border: isHover ? '1px solid rgba(59,130,246,0.15)' : '1px solid transparent',
                }}
                onMouseEnter={() => setHovered(idx)}
                onMouseLeave={() => setHovered(null)}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.35,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }} title={row.fullName}>
                    {row.fullName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontWeight: 600 }}>
                    {row.totalJobs} jobs total
                  </div>
                </div>

                <div style={{ position: 'relative', minHeight: 44 }}>
                  {/* Vertical grid */}
                  <div style={{ position: 'absolute', inset: '0 0 0 0', display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }}>
                    {xTicks.map(t => (
                      <div key={t} style={{ width: 1, height: '100%', background: 'var(--border-light)', opacity: 0.85 }} />
                    ))}
                  </div>

                  {/* Sedan bar */}
                  <div style={{ position: 'relative', height: 20, marginBottom: 6, display: 'flex', alignItems: 'center' }}>
                    {row.sedan > 0 ? (
                      <>
                        <div
                          className="fi-bar-fill"
                          style={{
                            height: 10,
                            width: `${barPct(row.sedanDisplay)}%`,
                            borderRadius: 5,
                            background: row.sedanOutlier
                              ? 'repeating-linear-gradient(90deg, #93c5fd 0, #2563eb 8px, #93c5fd 8px, #2563eb 16px)'
                              : 'linear-gradient(90deg, #93c5fd 0%, #3b82f6 55%, #2563eb 100%)',
                            boxShadow: '0 1px 3px rgba(37,99,235,0.25)',
                            minWidth: row.sedan > 0 ? 4 : 0,
                          }}
                        />
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 800, color: SEDAN,
                          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                        }}>
                          {row.sedanOutlier ? `${fmtMinShort(row.sedan)}+` : fmtMinShort(row.sedan)}
                          <span style={{ fontWeight: 600, color: 'var(--text-muted)', marginLeft: 4 }}>×{row.sedanCount}</span>
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                    )}
                  </div>

                  {/* SUV bar */}
                  <div style={{ position: 'relative', height: 20, display: 'flex', alignItems: 'center' }}>
                    {row.suv > 0 ? (
                      <>
                        <div
                          className="fi-bar-fill"
                          style={{
                            height: 10,
                            width: `${barPct(row.suvDisplay)}%`,
                            borderRadius: 5,
                            background: row.suvOutlier
                              ? 'repeating-linear-gradient(90deg, #6ee7b7 0, #059669 8px, #6ee7b7 8px, #059669 16px)'
                              : 'linear-gradient(90deg, #6ee7b7 0%, #10b981 55%, #059669 100%)',
                            boxShadow: '0 1px 3px rgba(5,150,105,0.25)',
                            minWidth: row.suv > 0 ? 4 : 0,
                            animationDelay: '0.06s',
                          }}
                        />
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 800, color: SUV,
                          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                        }}>
                          {row.suvOutlier ? `${fmtMinShort(row.suv)}+` : fmtMinShort(row.suv)}
                          <span style={{ fontWeight: 600, color: 'var(--text-muted)', marginLeft: 4 }}>×{row.suvCount}</span>
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                    )}
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  {delta != null ? (
                    <span style={{
                      display: 'inline-block', padding: '5px 10px', borderRadius: 8,
                      fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                      background: Math.abs(delta) >= 10 ? 'rgba(249,115,22,0.1)' : 'rgba(100,116,139,0.08)',
                      color: delta > 5 ? '#ea580c' : delta < -5 ? '#059669' : 'var(--text-muted)',
                      border: `1px solid ${Math.abs(delta) >= 10 ? 'rgba(249,115,22,0.2)' : 'var(--border-light)'}`,
                    }}>
                      {delta > 0 ? '+' : ''}{Math.round(delta)}m
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                  )}
                </div>

                {isHover && (
                  <div style={{
                    position: 'absolute', left: '24%', top: '100%', zIndex: 20, marginTop: 6,
                    pointerEvents: 'none',
                  }}>
                    <ChartTooltipPanel row={row} scaleMax={scaleMax} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer scale label */}
        <div style={{
          marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-light)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 10, color: 'var(--text-muted)', fontWeight: 600,
        }}>
          <span>0 min</span>
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Average duration →</span>
          <span>{scaleMax >= 60 ? fmtMin(scaleMax) : `${scaleMax} min`}</span>
        </div>
      </div>
    </div>
  );
};

interface ServiceJobRow {
  service_item_id: number;
  visit_id: number;
  vehicle_id: number;
  plate_number: string;
  make: string;
  model: string;
  year: number | null;
  color: string;
  vehicle_type: string;
  vehicle_label: string;
  owner_name: string;
  owner_phone: string;
  duration_minutes: number | null;
  duration_source: string;
  estimated_duration: number;
  vs_estimate_minutes: number | null;
  price: number;
  visit_date: string | null;
  visit_status: string;
  item_status: string;
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
};

const tdStyle: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 13,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-light)',
  verticalAlign: 'middle',
};

/* ─── Expanded job rows (lazy-loaded vehicle details) ─────────────────────── */
const ServiceJobsPanel: React.FC<{ serviceName: string; days: number; row: ServiceByTypeRow }> = ({
  serviceName, days, row,
}) => {
  const [typeFilter, setTypeFilter] = useState<'all' | 'sedan' | 'suv'>('all');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['fleet-intel', 'service-jobs', days, serviceName],
    queryFn: () =>
      analyticsApi.serviceDurationJobs({ service_name: serviceName, days, vehicle_types: 'sedan,suv' }).then(r => r.data),
  });

  const jobs = (data?.jobs ?? []) as ServiceJobRow[];
  const filtered = typeFilter === 'all' ? jobs : jobs.filter(j => j.vehicle_type === typeFilter);

  const sedanAvg = row.by_type.sedan?.avg_minutes;
  const suvAvg = row.by_type.suv?.avg_minutes;

  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(59,130,246,0.04) 0%, var(--bg-base) 100%)',
      borderTop: '1px solid var(--border-light)',
      padding: '16px 18px 18px',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>
            Vehicle breakdown — {serviceName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
            {deltaPhrase(row.suv_vs_sedan_delta_minutes, sedanAvg ?? null, suvAvg ?? null)}
            {' · '}{jobs.length} job{jobs.length !== 1 ? 's' : ''} in period
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-surface)', borderRadius: 10, padding: 3, border: '1px solid var(--border-light)' }}>
          {(['all', 'sedan', 'suv'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={e => { e.stopPropagation(); setTypeFilter(f); }}
              style={{
                padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
                background: typeFilter === f ? 'var(--bg-elevated)' : 'transparent',
                color: typeFilter === f
                  ? (f === 'sedan' ? SEDAN : f === 'suv' ? SUV : 'var(--text-primary)')
                  : 'var(--text-muted)',
                boxShadow: typeFilter === f ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {f === 'all' ? 'All types' : f}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
          <div className="spinner" style={{ width: 28, height: 28 }} />
        </div>
      ) : isError ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#ef4444', fontSize: 13 }}>Could not load vehicle details</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No jobs for this filter</div>
      ) : (
        <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid var(--border-light)', background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
            <thead>
              <tr>
                {['Plate', 'Vehicle', 'Type', 'Color', 'Owner', 'Duration', 'vs Est.', 'Price', 'Visit', ''].map(h => (
                  <th key={h || 'act'} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((j, idx) => {
                const col = TYPE_COLORS[j.vehicle_type] || TYPE_COLORS.other;
                const vs = j.vs_estimate_minutes;
                return (
                  <tr
                    key={j.service_item_id}
                    style={{ background: idx % 2 === 1 ? 'rgba(59,130,246,0.02)' : 'transparent' }}
                  >
                    <td style={tdStyle}>
                      <Link
                        to={`/vehicles/${j.vehicle_id}`}
                        onClick={e => e.stopPropagation()}
                        style={{
                          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 12,
                          color: 'var(--text-accent)', textDecoration: 'none',
                          background: 'rgba(59,130,246,0.08)', padding: '3px 8px', borderRadius: 6,
                        }}
                      >
                        {j.plate_number}
                      </Link>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {j.vehicle_label}
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                        padding: '3px 8px', borderRadius: 99, background: `${col}14`, color: col,
                      }}>
                        {j.vehicle_type}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{j.color || '—'}</td>
                    <td style={tdStyle}>
                      {j.owner_name ? (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{j.owner_name}</div>
                          {j.owner_phone && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{j.owner_phone}</div>}
                        </div>
                      ) : '—'}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>
                        {j.duration_minutes != null ? fmtMinShort(j.duration_minutes) : '—'}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, textTransform: 'capitalize' }}>
                        {j.duration_source}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {vs != null ? (
                        <span style={{
                          fontWeight: 700, fontSize: 12,
                          color: vs > 5 ? '#ea580c' : vs < -5 ? '#059669' : 'var(--text-muted)',
                        }}>
                          {vs > 0 ? '+' : ''}{Math.round(vs)}m
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: '#10b981' }}>QAR {j.price.toFixed(0)}</td>
                    <td style={{ ...tdStyle, fontSize: 11, whiteSpace: 'nowrap' }}>
                      {j.visit_date ? fmtQatar(j.visit_date, 'medDate') : '—'}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'capitalize', marginTop: 2 }}>
                        {j.visit_status.replace(/_/g, ' ')}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <Link
                        to={`/visits/${j.visit_id}`}
                        onClick={e => e.stopPropagation()}
                        className="btn btn-ghost btn-sm"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px' }}
                      >
                        Open <ExternalLink size={11} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/* ─── Service × body-type comparison (primary view) ─────────────────────── */
const ServiceComparisonView: React.FC<{
  rows: ServiceByTypeRow[];
  days: number;
  expanded: string | null;
  onExpand: (name: string | null) => void;
}> = ({ rows, days, expanded, onExpand }) => {
  if (rows.length === 0) {
    return (
      <div className="card" style={{ padding: 56, textAlign: 'center', border: '1px solid var(--border-light)' }}>
        <Wrench size={40} color="var(--text-muted)" style={{ marginBottom: 16, opacity: 0.5 }} />
        <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800 }}>No service timing data yet</h3>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, maxWidth: 420, marginInline: 'auto', lineHeight: 1.6 }}>
          Complete visits on Sedans and SUVs with service line items to see how long each job takes per body type.
        </p>
        <Link to="/visits" className="btn btn-primary" style={{ marginTop: 20, textDecoration: 'none', display: 'inline-flex' }}>
          View visits
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <ServiceDurationChart rows={rows} days={days} />

      {/* Professional expandable table */}
      <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)' }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-elevated)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>All services — side-by-side</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
              Click a row to expand and view every vehicle job · Sedan vs SUV timing
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
            <span><span style={{ color: SEDAN }}>●</span> Sedan avg</span>
            <span><span style={{ color: SUV }}>●</span> SUV avg</span>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 40, paddingLeft: 16 }} />
                <th style={{ ...thStyle, minWidth: 160 }}>Service</th>
                <th style={thStyle}>Category</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Est.</th>
                <th style={{ ...thStyle, textAlign: 'right', color: SEDAN }}>Sedan</th>
                <th style={{ ...thStyle, textAlign: 'right', color: SUV }}>SUV</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Gap</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Jobs</th>
                <th style={{ ...thStyle, textAlign: 'right', paddingRight: 18 }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                const isOpen = expanded === row.service_name;
                const sedan = row.by_type.sedan;
                const suv = row.by_type.suv;
                const sedanAvg = sedan?.avg_minutes ?? null;
                const suvAvg = suv?.avg_minutes ?? null;
                const delta = row.suv_vs_sedan_delta_minutes;

                return (
                  <React.Fragment key={row.service_name}>
                    <tr
                      onClick={() => onExpand(isOpen ? null : row.service_name)}
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
                      <td style={{ ...tdStyle, paddingLeft: 16, width: 40 }}>
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
                      <td style={{ ...tdStyle, fontWeight: 800, color: 'var(--text-primary)', minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{
                            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                            background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.15)',
                            display: 'grid', placeItems: 'center',
                          }}>
                            <Wrench size={14} color="var(--text-accent)" />
                          </span>
                          {row.service_name}
                        </div>
                      </td>
                      <td style={{ ...tdStyle, textTransform: 'capitalize', fontSize: 12 }}>{row.category}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)' }}>
                        {row.estimated_duration}m
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: SEDAN }}>{fmtMinShort(sedanAvg)}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>×{sedan?.count ?? 0}</div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: SUV }}>{fmtMinShort(suvAvg)}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>×{suv?.count ?? 0}</div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {delta != null ? (
                          <span style={{
                            fontWeight: 800, fontSize: 13,
                            color: Math.abs(delta) >= 10 ? '#ea580c' : Math.abs(delta) < 3 ? 'var(--text-muted)' : '#059669',
                          }}>
                            {delta > 0 ? '+' : ''}{Math.round(delta)}m
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: 'var(--text-accent)' }}>
                        {row.total_jobs}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#10b981', paddingRight: 18 }}>
                        QAR {row.total_revenue.toLocaleString()}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={9} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                          <ServiceJobsPanel serviceName={row.service_name} days={days} row={row} />
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
    </div>
  );
};

const TypeIcon: React.FC<{ type: string; size?: number }> = ({ type, size = 18 }) => {
  const t = type.toLowerCase();
  if (t === 'truck') return <Gauge size={size} color={TYPE_COLORS.truck} />;
  if (t === 'suv') return <Car size={size} color={TYPE_COLORS.suv} />;
  return <Car size={size} color={TYPE_COLORS[t] || TYPE_COLORS.other} />;
};

export const FleetIntelligence: React.FC = () => {
  const [days, setDays] = useState<number>(90);
  const [tab, setTab] = useState<TabId>('service');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [expandedService, setExpandedService] = useState<string | null>(null);

  const { data: svcByType = [], isLoading: loadingSvcByType, refetch: refetchSvcByType } = useQuery({
    queryKey: ['fleet-intel', 'service-by-type', days],
    queryFn: () =>
      analyticsApi.serviceDurationByVehicleType({ days, vehicle_types: 'sedan,suv' }).then(r => r.data as ServiceByTypeRow[]),
  });

  const { data: byType = [], isLoading: loadingType, refetch: refetchType } = useQuery({
    queryKey: ['fleet-intel', 'by-vehicle-type', days],
    queryFn: () => analyticsApi.byVehicleType({ days }).then(r => r.data as TypeRow[]),
  });

  const { data: byModel = [], isLoading: loadingModel, refetch: refetchModel } = useQuery({
    queryKey: ['fleet-intel', 'by-vehicle-model', days],
    queryFn: () => analyticsApi.byVehicleModel({ days }).then(r => r.data as ModelRow[]),
  });

  const { data: summary } = useQuery({
    queryKey: ['fleet-intel', 'summary', days],
    queryFn: () => analyticsApi.summary({ days }).then(r => r.data),
  });

  const isLoading = loadingSvcByType || loadingType || loadingModel;

  const serviceKpis = useMemo((): {
    servicesTracked: number;
    totalJobs: number;
    sedanWeightedAvg: number | null;
    suvWeightedAvg: number | null;
    biggestGap: { name: string; delta: number } | null;
  } => {
    const rows = svcByType as ServiceByTypeRow[];
    let sedanTotal = 0;
    let sedanCount = 0;
    let suvTotal = 0;
    let suvCount = 0;
    let biggestGap: { name: string; delta: number } | null = null;

    rows.forEach(r => {
      const s = r.by_type.sedan;
      const u = r.by_type.suv;
      if (s?.avg_minutes != null) {
        sedanTotal += s.avg_minutes * s.count;
        sedanCount += s.count;
      }
      if (u?.avg_minutes != null) {
        suvTotal += u.avg_minutes * u.count;
        suvCount += u.count;
      }
      if (r.suv_vs_sedan_delta_minutes != null) {
        if (!biggestGap || Math.abs(r.suv_vs_sedan_delta_minutes) > Math.abs(biggestGap.delta)) {
          biggestGap = { name: r.service_name, delta: r.suv_vs_sedan_delta_minutes };
        }
      }
    });

    return {
      servicesTracked: rows.length,
      totalJobs: rows.reduce((s, r) => s + r.total_jobs, 0),
      sedanWeightedAvg: sedanCount ? sedanTotal / sedanCount : null,
      suvWeightedAvg: suvCount ? suvTotal / suvCount : null,
      biggestGap,
    };
  }, [svcByType]);

  const chartData = useMemo(
    () =>
      (byType as TypeRow[])
        .filter(r => BODY_TYPES.includes(r.vehicle_type as typeof BODY_TYPES[number]))
        .slice()
        .sort((a, b) => b.avg_duration_minutes - a.avg_duration_minutes)
        .map(r => ({
          key: r.vehicle_type,
          name: cap(r.vehicle_type),
          duration: r.avg_duration_minutes,
          count: r.count,
          revenue: r.avg_revenue,
          fill: TYPE_COLORS[r.vehicle_type] || TYPE_COLORS.other,
        })),
    [byType],
  );

  const maxDuration = useMemo(() => Math.max(...chartData.map(d => d.duration), 1), [chartData]);

  const filteredModels = useMemo(() => {
    const list = (byModel as ModelRow[]).filter(m => BODY_TYPES.includes(m.vehicle_type as typeof BODY_TYPES[number])).slice(0, 20);
    if (!selectedType) return list;
    return list.filter(m => m.vehicle_type === selectedType);
  }, [byModel, selectedType]);

  const typeInsight = useMemo(() => {
    if (!selectedType) return null;
    const row = (byType as TypeRow[]).find(r => r.vehicle_type === selectedType);
    if (!row) return null;
    const fleetAvg = Number(summary?.avg_duration_minutes ?? 0);
    const delta = fleetAvg > 0 ? row.avg_duration_minutes - fleetAvg : 0;
    const modelsOfType = (byModel as ModelRow[]).filter(m => m.vehicle_type === selectedType);
    const slowest = modelsOfType.slice().sort((a, b) => b.avg_duration_minutes - a.avg_duration_minutes)[0];
    return { row, fleetAvg, delta, slowest };
  }, [selectedType, byType, byModel, summary]);

  const refreshAll = () => {
    refetchSvcByType();
    refetchType();
    refetchModel();
    toast.success('Fleet intelligence refreshed');
  };

  const exportCsv = () => {
    const rows: string[][] = [['Service', 'Sedan avg (min)', 'Sedan jobs', 'SUV avg (min)', 'SUV jobs', 'SUV−Sedan delta', 'Est. (min)']];
    (svcByType as ServiceByTypeRow[]).forEach(r => {
      rows.push([
        r.service_name,
        String(r.by_type.sedan?.avg_minutes ?? ''),
        String(r.by_type.sedan?.count ?? 0),
        String(r.by_type.suv?.avg_minutes ?? ''),
        String(r.by_type.suv?.count ?? 0),
        String(r.suv_vs_sedan_delta_minutes ?? ''),
        String(r.estimated_duration),
      ]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fleet-service-duration-suv-sedan-${days}d-${qatarYmd()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported');
  };

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'service', label: 'By Service', icon: <Wrench size={14} /> },
    { id: 'type', label: 'By Vehicle Type', icon: <Car size={14} /> },
    { id: 'model', label: 'By Model', icon: <Layers size={14} /> },
  ];

  return (
    <div className="animate-fade-in">
      <div style={{
        borderRadius: 20, overflow: 'hidden', marginBottom: 22,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(16,185,129,0.06) 50%, rgba(139,92,246,0.04) 100%)',
      }}>
        <div style={{ padding: '28px 30px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.35), rgba(16,185,129,0.28))',
                border: '1px solid rgba(96,165,250,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 12px 40px rgba(59,130,246,0.15)',
              }}>
                <BarChart2 size={28} color="var(--text-accent)" />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                  <h1 className="page-title" style={{ margin: 0, fontSize: 28, letterSpacing: '-0.03em' }}>Fleet intelligence</h1>
                  <span style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                    padding: '5px 12px', borderRadius: 99,
                    background: 'rgba(59,130,246,0.12)', color: 'var(--text-accent)',
                    border: '1px solid rgba(59,130,246,0.25)',
                  }}>
                    Last {days}d
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)', maxWidth: 640, lineHeight: 1.65 }}>
                  <Sparkles size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} />
                  How long each service takes on <strong style={{ color: SEDAN }}>Sedans</strong> vs <strong style={{ color: SUV }}>SUVs</strong> — plan bays, estimates, and staffing with confidence.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={refreshAll} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Refresh
              </button>
              <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!svcByType.length} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Download size={14} /> Export
              </button>
              <Link to="/vehicles" className="btn btn-ghost" style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                <Car size={14} /> Fleet registry <ArrowRight size={14} />
              </Link>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 22 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Period</span>
            {PERIODS.map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                style={{
                  padding: '6px 14px', borderRadius: 99, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: `1px solid ${days === d ? 'var(--text-accent)' : 'var(--border)'}`,
                  background: days === d ? 'rgba(59,130,246,0.12)' : 'var(--bg-surface)',
                  color: days === d ? 'var(--text-accent)' : 'var(--text-muted)',
                }}
              >
                {d}d
              </button>
            ))}
            <div style={{ flex: 1, minWidth: 200 }} />
            <div style={{ display: 'flex', gap: 4, background: 'var(--bg-base)', borderRadius: 12, padding: 4, border: '1px solid var(--border-light)' }}>
              {tabs.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 700, transition: 'all 0.15s',
                    background: tab === t.id ? 'var(--bg-elevated)' : 'transparent',
                    color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: tab === t.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* KPI strip — service / SUV vs Sedan focused */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 22 }}>
        {[
          {
            label: 'Services tracked',
            value: serviceKpis.servicesTracked,
            sub: `${serviceKpis.totalJobs} jobs in window`,
            icon: Wrench,
            color: 'var(--text-accent)',
          },
          {
            label: 'Sedan avg time',
            value: fmtMinShort(serviceKpis.sedanWeightedAvg),
            sub: 'Weighted across all services',
            icon: Car,
            color: SEDAN,
          },
          {
            label: 'SUV avg time',
            value: fmtMinShort(serviceKpis.suvWeightedAvg),
            sub: 'Weighted across all services',
            icon: Car,
            color: SUV,
          },
          {
            label: 'Biggest SUV ↔ Sedan gap',
            value: (() => {
              const g = serviceKpis.biggestGap;
              return g ? fmtMinShort(Math.abs(g.delta)) : '—';
            })(),
            sub: (() => {
              const g = serviceKpis.biggestGap;
              if (!g) return 'Need both body types per service';
              const n = g.name;
              return n.length > 28 ? `${n.slice(0, 28)}…` : n;
            })(),
            icon: TrendingUp,
            color: '#f97316',
          },
        ].map(({ label, value, sub, icon: Icon, color }) => (
          <div key={label} className="card" style={{ padding: '18px 20px', border: '1px solid var(--border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 12,
                background: `${color}14`, border: `1px solid ${color}30`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={20} color={color} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{value}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub}>{sub}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <div className="spinner" style={{ width: 36, height: 36 }} />
        </div>
      ) : (
        <>
          {tab === 'service' && (
            <ServiceComparisonView
              rows={svcByType as ServiceByTypeRow[]}
              days={days}
              expanded={expandedService}
              onExpand={setExpandedService}
            />
          )}

          {tab === 'type' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(280px, 360px)', gap: 20, alignItems: 'start' }}>
              <div className="card" style={{ padding: '22px 24px', border: '1px solid var(--border-light)' }}>
                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Visit duration — Sedan vs SUV</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>Whole-visit dwell time by body type</div>

                {chartData.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No Sedan/SUV visit data</div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} unit="m" />
                        <Tooltip contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 }} />
                        <Bar dataKey="duration" radius={[6, 6, 0, 0]} maxBarSize={56}>
                          {chartData.map(d => (
                            <Cell key={d.key} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setSelectedType(d.key)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>

                    <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {chartData.map(r => {
                        const col = TYPE_COLORS[r.key] || TYPE_COLORS.other;
                        const active = selectedType === r.key;
                        const pct = (r.duration / maxDuration) * 100;
                        return (
                          <button
                            key={r.key}
                            type="button"
                            onClick={() => setSelectedType(active ? null : r.key)}
                            style={{
                              display: 'grid', gridTemplateColumns: '100px 1fr 72px 64px',
                              alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12,
                              border: `1px solid ${active ? col : 'var(--border-light)'}`,
                              background: active ? `${col}0c` : 'var(--bg-base)',
                              cursor: 'pointer', textAlign: 'left', width: '100%',
                            }}
                          >
                            <span style={{ fontWeight: 700, fontSize: 13, color: col, textTransform: 'capitalize' }}>{r.name}</span>
                            <div style={{ height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: col, borderRadius: 99 }} />
                            </div>
                            <div style={{ textAlign: 'right', fontWeight: 800, fontSize: 14, color: col }}>{r.duration}m</div>
                            <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>×{r.count}</div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <div className="card" style={{ padding: '20px 22px', border: '1px solid var(--border-light)', position: 'sticky', top: 16 }}>
                {!selectedType || !typeInsight ? (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
                    Select Sedan or SUV for visit-level stats
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                      <TypeIcon type={selectedType} size={22} />
                      <div style={{ fontSize: 18, fontWeight: 800, textTransform: 'capitalize' }}>{selectedType}</div>
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 900, color: TYPE_COLORS[selectedType], marginBottom: 8 }}>
                      {typeInsight.row.avg_duration_minutes} <span style={{ fontSize: 16 }}>min avg visit</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
                      {typeInsight.delta > 5 ? (
                        <span style={{ color: '#ea580c' }}>{Math.round(typeInsight.delta)} min above fleet average</span>
                      ) : (
                        <span>{typeInsight.row.count} visits · QAR {typeInsight.row.avg_revenue} avg</span>
                      )}
                    </div>
                    <button type="button" className="btn btn-secondary" style={{ width: '100%' }} onClick={() => setTab('service')}>
                      Compare services by type <ChevronRight size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'model' && (
            <div className="card" style={{ overflow: 'hidden', border: '1px solid var(--border-light)' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-light)' }}>
                <div style={{ fontSize: 16, fontWeight: 800 }}>Duration by make & model</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Sedan & SUV only · top 20 by volume</div>
              </div>
              {filteredModels.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>No model data</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-elevated)' }}>
                        {['Model', 'Type', 'Visits', 'Avg duration', 'Avg revenue', ''].map(h => (
                          <th key={h} style={{ padding: '12px 18px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredModels.map(m => {
                        const col = TYPE_COLORS[m.vehicle_type] || TYPE_COLORS.other;
                        const open = expandedModel === m.label;
                        return (
                          <React.Fragment key={m.label}>
                            <tr style={{ cursor: 'pointer', borderBottom: '1px solid var(--border-light)' }} onClick={() => setExpandedModel(open ? null : m.label)}>
                              <td style={{ padding: '12px 18px', fontWeight: 700 }}>{m.label}</td>
                              <td style={{ padding: '12px 18px' }}>
                                <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', padding: '3px 9px', borderRadius: 99, background: `${col}18`, color: col }}>{m.vehicle_type}</span>
                              </td>
                              <td style={{ padding: '12px 18px', fontWeight: 800, color: 'var(--text-accent)' }}>{m.count}</td>
                              <td style={{ padding: '12px 18px', fontWeight: 800, color: col }}>{m.avg_duration_minutes}m</td>
                              <td style={{ padding: '12px 18px', color: '#10b981' }}>QAR {m.avg_revenue}</td>
                              <td style={{ padding: '12px 18px' }}><ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : 'none' }} /></td>
                            </tr>
                            {open && (
                              <tr>
                                <td colSpan={6} style={{ padding: '12px 18px 18px', background: 'var(--bg-base)' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                                    {[
                                      { label: 'Total visits', value: m.count },
                                      { label: 'Total revenue', value: `QAR ${(m.total_revenue ?? 0).toLocaleString()}` },
                                      { label: 'Avg services / visit', value: m.avg_services ?? '—' },
                                    ].map(s => (
                                      <div key={s.label} style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: 18, fontWeight: 800 }}>{s.value}</div>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.label}</div>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
