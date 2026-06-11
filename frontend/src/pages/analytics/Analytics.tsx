import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, TrendingUp, Car, Clock, DollarSign,
  Calendar, ArrowUp, ArrowDown, Activity,
  Users as UsersIcon, BarChart2, Wrench, Award, Target,
  Download, RefreshCw, Sparkles, Brain,
  Gauge, ScanLine, Zap, ArrowRight, LayoutDashboard,
  ChevronRight, AlertTriangle, Truck, Bus, Bike, PieChart as PieChartIcon,
  Printer,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend, Line, ComposedChart,
} from 'recharts';
import { analyticsApi, anprApi } from '../../services/api';
import { fmtQatar, qatarYmd, qatarYearNow } from '../../lib/qatarTime';

type AnalyticsTabId = 'overview' | 'services' | 'staff' | 'seasonal' | 'intelligence';

type InsightTone = 'growth' | 'watch' | 'ops' | 'ai';

interface SmartInsight {
  tone: InsightTone;
  title: string;
  detail: string;
  action?: { label: string; to: string };
}

function buildSmartInsights(args: {
  days: number;
  stats: Record<string, unknown> | undefined;
  daily: { date?: string; revenue?: number; count?: number }[] | undefined;
  services: { service_name?: string; count?: number; total_revenue?: number }[] | undefined;
  dashboard: Record<string, unknown> | undefined;
  completionRate: number;
}): SmartInsight[] {
  const out: SmartInsight[] = [];
  const { days, stats, daily, services, dashboard, completionRate } = args;

  if (daily && daily.length >= 4) {
    const mid = Math.floor(daily.length / 2);
    const first = daily.slice(0, mid).reduce((s, d) => s + (Number(d.revenue) || 0), 0);
    const second = daily.slice(mid).reduce((s, d) => s + (Number(d.revenue) || 0), 0);
    if (first > 0 && second > first * 1.08) {
      out.push({
        tone: 'growth',
        title: 'Revenue momentum',
        detail: `The later half of your ${days}-day window beat earlier revenue — demand looks firm.`,
        action: { label: 'Visits pipeline', to: '/visits' },
      });
    } else if (first > 0 && second < first * 0.92) {
      out.push({
        tone: 'watch',
        title: 'Cooling revenue trend',
        detail: 'Recent days trail earlier totals — worth scanning pricing, completion, and upsell.',
        action: { label: 'Service catalogue', to: '/services' },
      });
    }
  }

  const peak = stats?.peak_hour;
  if (peak != null && peak !== '') {
    out.push({
      tone: 'ops',
      title: `Peak arrivals · ${peak}:00`,
      detail: 'Front desk and bay scheduling around this hour reduces bottlenecks.',
      action: { label: 'Live visits', to: '/visits' },
    });
  }

  const top = services?.[0];
  if (top?.service_name) {
    out.push({
      tone: 'ai',
      title: `Demand signal · ${top.service_name}`,
      detail: `${top.count ?? 0} line items · QAR ${(Number(top.total_revenue) || 0).toLocaleString()} — align stock and bundles.`,
      action: { label: 'Edit services', to: '/services' },
    });
  }

  const totalCars = Number(stats?.total_cars ?? 0);
  if (completionRate < 52 && totalCars > 8) {
    out.push({
      tone: 'watch',
      title: 'Completion gap',
      detail: `${completionRate}% of visits marked completed in-window — close open jobs to protect revenue.`,
      action: { label: 'Active visits', to: '/visits' },
    });
  }

  const inShop = Number(dashboard?.cars_in_shop ?? 0);
  if (inShop >= 4) {
    out.push({
      tone: 'ops',
      title: 'High shop occupancy',
      detail: `${inShop} vehicles in workflow — monitor wait times and bay turnover.`,
      action: { label: 'Operations hub', to: '/' },
    });
  }

  const pending = Number(dashboard?.anpr_pending_visits ?? 0);
  if (pending > 0) {
    out.push({
      tone: 'ai',
      title: 'Camera plates pending linkage',
      detail: `${pending} ANPR reads today still need a CarTrack visit — sync from VisionFlow.`,
      action: { label: 'ANPR & speed', to: '/visionflow' },
    });
  }

  const avgDur = Number(stats?.avg_duration_minutes ?? 0);
  if (avgDur > 88 && totalCars > 5) {
    out.push({
      tone: 'watch',
      title: 'Elevated dwell time',
      detail: `Average ${Math.round(avgDur)} min per visit — review service throughput and staging.`,
      action: { label: 'Staff KPIs', to: '/analytics?tab=staff' },
    });
  }

  const anprToday = Number(dashboard?.anpr_detected_today ?? 0);
  if (anprToday > 0 && !pending) {
    out.push({
      tone: 'ai',
      title: 'Vision pipeline healthy',
      detail: `${anprToday} plate reads recorded today with linkage on track.`,
      action: { label: 'Analysis history', to: '/visionflow/history' },
    });
  }

  if (out.length === 0 && totalCars > 0) {
    out.push({
      tone: 'growth',
      title: 'Balanced snapshot',
      detail: 'No critical anomalies in this window — keep logging service timings for sharper forecasts.',
      action: { label: 'New visit', to: '/visits/new' },
    });
  }

  return out.slice(0, 10);
}

function exportAnalyticsCSV(data: any[], filename: string) {
  if (!data?.length) return;
  const keys = Object.keys(data[0]);
  const csv = [keys, ...data.map(r => keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`))]
    .map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${filename}-${qatarYmd()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

const printTableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 10,
  marginBottom: 14,
};
const printThStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: '2px solid #111',
  padding: '6px 8px',
  fontWeight: 700,
  background: '#f3f4f6',
};
const printTdStyle: React.CSSProperties = {
  borderBottom: '1px solid #ddd',
  padding: '5px 8px',
  verticalAlign: 'top',
};
const printSectionTitle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  margin: '18px 0 8px',
  paddingBottom: 4,
  borderBottom: '1px solid #ccc',
  pageBreakAfter: 'avoid',
};

/** Full snapshot for print / PDF — hidden on screen, shown only in print CSS */
function AnalyticsPrintReport(props: {
  days: number;
  stats: Record<string, unknown> | undefined;
  dashboard: Record<string, unknown> | undefined;
  daily: { date?: string; revenue?: number; count?: number }[] | undefined;
  hourly: { hour?: number; count?: number; anpr?: number }[] | undefined;
  services: any[] | undefined;
  serviceDuration: any[] | undefined;
  vehicleTypes: any[] | undefined;
  staffKpi: any[] | undefined;
  seasonal: any[] | undefined;
  smartInsights: SmartInsight[];
  anprSnap: Record<string, unknown> | undefined;
  completionRate: number;
}) {
  const {
    days, stats, dashboard, daily, hourly, services, serviceDuration, vehicleTypes,
    staffKpi, seasonal, smartInsights, anprSnap, completionRate,
  } = props;
  const generated = fmtQatar(new Date(), 'dmyHm');
  const totalRev = Number(stats?.total_revenue ?? 0);
  const totalCars = Number(stats?.total_cars ?? 0);

  return (
    <div className="analytics-print-root" style={{ color: '#111', background: '#fff' }}>
      <div style={{ borderBottom: '3px solid #1e40af', paddingBottom: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.02em' }}>CarTrack Pro</div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>Analytics &amp; intelligence — full report</div>
        <div style={{ fontSize: 10, color: '#444', marginTop: 8 }}>
          Generated {generated} · Rolling window: last <strong>{days}</strong> days · Currency: QAR
        </div>
      </div>

      <div style={printSectionTitle}>Executive summary</div>
      <table style={printTableStyle}>
        <tbody>
          {[
            ['Total visits (window)', String(totalCars)],
            ['Total revenue (window)', `QAR ${totalRev.toLocaleString()}`],
            ['Avg duration', `${Math.round(Number(stats?.avg_duration_minutes ?? 0))} min`],
            ['Peak hour', `${stats?.peak_hour ?? '—'}:00`],
            ['Completion rate', `${completionRate}%`],
            ['Avg revenue / visit', totalCars ? `QAR ${Math.round(totalRev / totalCars)}` : '—'],
            ['Cars in shop now', String(dashboard?.cars_in_shop ?? '—')],
            ['Revenue today', `QAR ${Number(dashboard?.total_revenue_today ?? 0).toLocaleString()}`],
            ['ANPR reads today', String(dashboard?.anpr_detected_today ?? anprSnap?.today_detections ?? '—')],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...printTdStyle, fontWeight: 600, width: '42%' }}>{k}</td>
              <td style={printTdStyle}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>AI &amp; operational insights</div>
      {smartInsights.length === 0 ? (
        <p style={{ fontSize: 10, color: '#666' }}>No automated insights for this window.</p>
      ) : (
        <ol style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 10, lineHeight: 1.5 }}>
          {smartInsights.map((ins, i) => (
            <li key={i} style={{ marginBottom: 8 }}>
              <strong>{ins.title}</strong> <span style={{ color: '#555' }}>({ins.tone})</span>
              <div style={{ marginTop: 2 }}>{ins.detail}</div>
            </li>
          ))}
        </ol>
      )}

      <div style={printSectionTitle}>Daily traffic &amp; revenue</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Date</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Cars</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Revenue (QAR)</th>
          </tr>
        </thead>
        <tbody>
          {(daily || []).map((d, i) => (
            <tr key={i}>
              <td style={printTdStyle}>{d.date ? String(d.date) : '—'}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{d.count ?? '—'}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{Number(d.revenue ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>Peak hours (arrivals)</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Hour</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Cars</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>ANPR reads</th>
          </tr>
        </thead>
        <tbody>
          {(hourly || []).map((h: any, i: number) => (
            <tr key={i}>
              <td style={printTdStyle}>{h.hour ?? '—'}:00</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{h.count ?? '—'}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{h.anpr ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>Service mix &amp; revenue</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>#</th>
            <th style={printThStyle}>Service</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Line items</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Revenue</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Share %</th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const total = (services || []).reduce((s: number, x: any) => s + (Number(x.total_revenue) || 0), 0);
            return (services || []).map((svc: any, i: number) => {
              const share = total ? Math.round((Number(svc.total_revenue || 0) / total) * 1000) / 10 : 0;
              return (
                <tr key={i}>
                  <td style={printTdStyle}>{i + 1}</td>
                  <td style={printTdStyle}>{svc.service_name}</td>
                  <td style={{ ...printTdStyle, textAlign: 'right' }}>{svc.count}</td>
                  <td style={{ ...printTdStyle, textAlign: 'right' }}>{Number(svc.total_revenue || 0).toLocaleString()}</td>
                  <td style={{ ...printTdStyle, textAlign: 'right' }}>{share}%</td>
                </tr>
              );
            });
          })()}
        </tbody>
      </table>

      <div style={printSectionTitle}>Service duration vs estimate</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Service</th>
            <th style={printThStyle}>Category</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>N</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Est (m)</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Actual (m)</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Eff. %</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {(serviceDuration || []).map((s: any, i: number) => (
            <tr key={i}>
              <td style={printTdStyle}>{s.service_name}</td>
              <td style={printTdStyle}>{s.category}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.count}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.estimated_duration}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.avg_actual_minutes ?? s.avg_actual_duration ?? '—'}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.efficiency != null ? `${s.efficiency}%` : '—'}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{Number(s.total_revenue || 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>Vehicle type breakdown</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Type</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Visits</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Avg revenue</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Avg dwell (m)</th>
          </tr>
        </thead>
        <tbody>
          {(vehicleTypes || []).map((vt: any, i: number) => (
            <tr key={i}>
              <td style={{ ...printTdStyle, textTransform: 'capitalize' }}>{vt.vehicle_type}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{vt.count}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{vt.avg_revenue}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{vt.avg_duration_minutes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>Staff KPIs ({days}d)</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Staff</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Services</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Revenue</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Avg time</th>
          </tr>
        </thead>
        <tbody>
          {(staffKpi || []).map((s: any, i: number) => (
            <tr key={s.staff_id ?? i}>
              <td style={printTdStyle}>{s.staff_name} (@{s.username})</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.services_count}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{Number(s.total_revenue || 0).toLocaleString()}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{s.avg_service_duration ? `${s.avg_service_duration}m` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>Seasonal · monthly ({qatarYearNow()})</div>
      <table style={printTableStyle}>
        <thead>
          <tr>
            <th style={printThStyle}>Month</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Cars</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Revenue</th>
            <th style={{ ...printThStyle, textAlign: 'right' }}>Avg duration</th>
          </tr>
        </thead>
        <tbody>
          {(seasonal || []).map((m: any, i: number) => (
            <tr key={m.month ?? i}>
              <td style={printTdStyle}>{m.month_name}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{m.count}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{Number(m.revenue || 0).toLocaleString()}</td>
              <td style={{ ...printTdStyle, textAlign: 'right' }}>{m.avg_duration ? `${m.avg_duration}m` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={printSectionTitle}>ANPR / VisionFlow snapshot</div>
      <table style={printTableStyle}>
        <tbody>
          {[
            ['Detections today', String(anprSnap?.today_detections ?? '—')],
            ['Unique plates today', String(anprSnap?.today_unique_plates ?? '—')],
            ['Avg speed (km/h)', anprSnap?.avg_speed_kmh != null ? String(anprSnap.avg_speed_kmh) : '—'],
            ['Total synced reads', String(anprSnap?.total_synced ?? '—')],
            ['Linked to vehicle', String(anprSnap?.linked_to_vehicle ?? '—')],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...printTdStyle, fontWeight: 600, width: '42%' }}>{k}</td>
              <td style={printTdStyle}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 24, paddingTop: 12, borderTop: '1px solid #ccc', fontSize: 9, color: '#666' }}>
        CarTrack Pro — operational analytics export. Charts are omitted; use on-screen Analytics for visuals.
      </div>
    </div>
  );
}

const COLORS = ['#6366f1','#3b82f6','#06b6d4','#ec4899','#f59e0b','#22c55e','#ef4444'];

function VehicleTypeGlyph({ type }: { type: string }) {
  const t = (type || 'other').toLowerCase();
  const Icon = t === 'truck' ? Truck : t === 'van' ? Bus : t === 'motorcycle' ? Bike : Car;
  return <Icon size={22} strokeWidth={2} />;
}

function ServicePieTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const p = payload[0].payload as {
    fullName: string; count: number; revenue: number; pctJobs: number; pctRev: number;
  };
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '12px 14px',
      fontSize: 12,
      boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
      minWidth: 200,
    }}>
      <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.35 }}>
        {p.fullName}
      </div>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
        <strong style={{ color: 'var(--text-accent)' }}>{p.count}</strong> line items ·{' '}
        <strong style={{ color: 'var(--text-purple)' }}>{p.pctJobs}%</strong> of jobs
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
        QAR <span style={{ color: '#a7f3d0', fontWeight: 700 }}>{(Number(p.revenue) || 0).toLocaleString()}</span>
        {' · '}{p.pctRev}% of period revenue
      </div>
    </div>
  );
}

function ServiceDistributionPanel({ services, days }: { services: any[] | undefined; days: number }) {
  const rows = useMemo(() => {
    const list = [...(services || [])].sort(
      (a, b) => (Number(b.count) || 0) - (Number(a.count) || 0),
    );
    const totalJobs = list.reduce((s, x) => s + (Number(x.count) || 0), 0);
    const totalRev = list.reduce((s, x) => s + (Number(x.total_revenue) || 0), 0);
    return list.map((x, i) => {
      const c = Number(x.count) || 0;
      const r = Number(x.total_revenue) || 0;
      return {
        ...x,
        color: COLORS[i % COLORS.length],
        pctJobs: totalJobs ? Math.round((c / totalJobs) * 1000) / 10 : 0,
        pctRev: totalRev ? Math.round((r / totalRev) * 1000) / 10 : 0,
        pieLabel:
          (x.service_name || 'Unknown').length > 18
            ? `${String(x.service_name).slice(0, 16)}…`
            : (x.service_name || 'Unknown'),
      };
    });
  }, [services]);

  const pieData = rows.map(r => ({
    name: r.pieLabel,
    fullName: r.service_name || 'Unknown',
    count: r.count,
    revenue: r.total_revenue,
    pctJobs: r.pctJobs,
    pctRev: r.pctRev,
  }));

  const totalJobs = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
  const totalRev = rows.reduce((s, r) => s + (Number(r.total_revenue) || 0), 0);
  const top = rows[0];

  if (!rows.length) {
    return (
      <div className="card card-p" style={{ borderRadius: 16, border: '1px solid var(--border-light)' }}>
        <div className="card-header">
          <div>
            <div className="card-title">Service distribution</div>
            <div className="card-subtitle">Mix of service line items in the selected window</div>
          </div>
        </div>
        <div className="empty-state" style={{ padding: 48 }}>
          <PieChartIcon size={36} color="var(--text-muted)" />
          <h3>No services in range</h3>
          <p>Record visits with services to see the mix.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        overflow: 'hidden',
        borderRadius: 16,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(165deg, var(--bg-surface) 0%, rgba(99,102,241,0.04) 55%, var(--bg-surface) 100%)',
      }}
    >
      <div className="card-header" style={{ padding: '18px 22px', borderBottom: '1px solid var(--border-light)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 13,
            background: 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(59,130,246,0.18))',
            border: '1px solid rgba(129,140,248,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <PieChartIcon size={22} color="#c7d2fe" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="card-title" style={{ marginBottom: 4 }}>Service distribution</div>
            <div className="card-subtitle" style={{ lineHeight: 1.5 }}>
              Share of <strong style={{ color: 'var(--text-primary)' }}>jobs</strong> by service — hover slices for revenue split. Last <strong>{days}d</strong>.
            </div>
          </div>
          <div style={{
            textAlign: 'right',
            padding: '8px 12px',
            borderRadius: 12,
            background: 'var(--bg-base)',
            border: '1px solid var(--border-light)',
            flexShrink: 0,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top SKU</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={top?.service_name}>
              {top?.service_name ?? '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-accent)', fontWeight: 700, marginTop: 2 }}>{top?.pctJobs ?? 0}% of jobs</div>
          </div>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
        gap: 20,
        padding: '20px 22px 22px',
        alignItems: 'center',
      }}>
        <div style={{ position: 'relative', height: 260, minWidth: 0, minHeight: 260 }}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={58}
                outerRadius={92}
                paddingAngle={2}
                stroke="var(--bg-base, #0f172a)"
                strokeWidth={3}
              >
                {rows.map((_, i) => (
                  <Cell key={rows[i].service_name ?? i} fill={COLORS[i % COLORS.length]} style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.2))' }} />
                ))}
              </Pie>
              <Tooltip content={<ServicePieTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            pointerEvents: 'none',
            width: 100,
          }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
              {totalJobs.toLocaleString()}
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>
              Line items
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-purple)', marginTop: 6 }}>
              QAR {Math.round(totalRev).toLocaleString()}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>period revenue</div>
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: 12,
          }}>
            Legend · tap-friendly rows
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 10,
            maxHeight: 280,
            overflowY: 'auto',
            paddingRight: 4,
          }}>
            {rows.map((r, i) => (
              <div
                key={r.service_name ?? i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-light)',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: 4,
                  background: r.color,
                  flexShrink: 0,
                  marginTop: 3,
                  boxShadow: `0 0 0 2px ${r.color}33`,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    lineHeight: 1.35,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }} title={r.service_name}>
                    {r.service_name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: 'var(--text-accent)', fontWeight: 800 }}>{r.count}</span>
                    <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>·</span>
                    <span style={{ fontWeight: 700 }}>{r.pctJobs}%</span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>jobs</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    QAR <span style={{ color: '#a7f3d0', fontWeight: 700 }}>{(Number(r.total_revenue) || 0).toLocaleString()}</span>
                    <span style={{ margin: '0 6px', opacity: 0.5 }}>·</span>
                    {r.pctRev}% rev
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function KPICard({ label, value, sub, icon: Icon, color, bg, trend, trendUp }: any) {
  return (
    <div
      className="stat-card animate-slide-up"
      style={{ transition: 'transform 0.18s ease, box-shadow 0.18s ease' }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,0,0,0.2)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.boxShadow = '';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="stat-icon-wrap" style={{ background: bg }}>
          <Icon size={20} color={color} />
        </div>
        {trend !== undefined && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 3,
            fontSize: 12, fontWeight: 700,
            color: trendUp ? '#10b981' : '#ef4444',
          }}>
            {trendUp ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {Math.abs(trend)}%
          </div>
        )}
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label" style={{ marginTop: 4 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '10px 14px', fontSize: 12,
    }}>
      <p style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color, fontWeight: 700, marginBottom: 2 }}>
          {p.name}: {typeof p.value === 'number' && p.name?.toLowerCase().includes('revenue')
            ? `QAR ${p.value.toLocaleString()}`
            : p.value}
        </p>
      ))}
    </div>
  );
};

const INSIGHT_STYLE: Record<InsightTone, { border: string; icon: typeof Sparkles; glow: string }> = {
  growth: { border: 'rgba(16,185,129,0.45)', icon: TrendingUp, glow: 'rgba(16,185,129,0.12)' },
  watch:  { border: 'rgba(251,191,36,0.5)', icon: AlertTriangle, glow: 'rgba(251,191,36,0.1)' },
  ops:    { border: 'rgba(59,130,246,0.45)', icon: Activity, glow: 'rgba(59,130,246,0.1)' },
  ai:     { border: 'rgba(139,92,246,0.5)', icon: Brain, glow: 'rgba(139,92,246,0.14)' },
};

export const Analytics: React.FC = () => {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [days, setDays] = useState(7);

  const tabFromUrl = searchParams.get('tab') as AnalyticsTabId | null;
  const [activeTab, setActiveTab] = useState<AnalyticsTabId>(() => {
    if (tabFromUrl === 'services' || tabFromUrl === 'staff' || tabFromUrl === 'seasonal' || tabFromUrl === 'intelligence') return tabFromUrl;
    return 'overview';
  });

  useEffect(() => {
    const t = searchParams.get('tab') as AnalyticsTabId | null;
    if (t === 'services' || t === 'staff' || t === 'seasonal' || t === 'intelligence') setActiveTab(t);
    if (t === 'overview') setActiveTab('overview');
  }, [searchParams]);

  const setTab = (id: AnalyticsTabId) => {
    setActiveTab(id);
    setSearchParams(id === 'overview' ? {} : { tab: id }, { replace: true });
  };

  const { data: stats } = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => analyticsApi.summary({ days }).then(r => r.data),
  });

  const { data: daily } = useQuery({
    queryKey: ['analytics-daily', days],
    queryFn: () => analyticsApi.daily({ days }).then(r => r.data),
    refetchInterval: 300000,
  });

  const { data: services } = useQuery({
    queryKey: ['analytics-services', days],
    queryFn: () => analyticsApi.byService({ days }).then(r => r.data),
  });

  const { data: hourly } = useQuery({
    queryKey: ['analytics-hourly'],
    queryFn: () => analyticsApi.hourly().then(r => r.data),
  });

  const { data: serviceDuration } = useQuery({
    queryKey: ['analytics-service-duration', days],
    queryFn: () => analyticsApi.serviceDuration({ days }).then(r => r.data),
  });

  const { data: vehicleTypes } = useQuery({
    queryKey: ['analytics-vehicle-types', days],
    queryFn: () => analyticsApi.byVehicleType({ days }).then(r => r.data),
  });

  const { data: staffKpi } = useQuery({
    queryKey: ['analytics-staff-kpi', days],
    queryFn: () => analyticsApi.staffKpi({ days }).then(r => r.data),
  });

  const { data: seasonal } = useQuery({
    queryKey: ['analytics-seasonal'],
    queryFn: () => analyticsApi.seasonal({}).then(r => r.data),
  });

  const { data: dashboard } = useQuery({
    queryKey: ['analytics-dashboard'],
    queryFn: () => analyticsApi.dashboard().then(r => r.data),
    refetchInterval: 45000,
  });

  const { data: anprSnap } = useQuery({
    queryKey: ['anpr-stats'],
    queryFn: () => anprApi.stats().then(r => r.data),
    refetchInterval: 90000,
  });

  const completionRate = stats?.total_cars && (stats as { cars_completed?: number }).cars_completed != null
    ? Math.round(((stats as { cars_completed: number }).cars_completed / stats.total_cars) * 100)
    : 0;

  const smartInsights = useMemo(
    () =>
      buildSmartInsights({
        days,
        stats: stats as Record<string, unknown> | undefined,
        daily,
        services,
        dashboard: dashboard as Record<string, unknown> | undefined,
        completionRate,
      }),
    [days, stats, daily, services, dashboard, completionRate],
  );

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['analytics'] });
    qc.invalidateQueries({ queryKey: ['analytics-daily'] });
    qc.invalidateQueries({ queryKey: ['analytics-services'] });
    qc.invalidateQueries({ queryKey: ['analytics-hourly'] });
    qc.invalidateQueries({ queryKey: ['analytics-service-duration'] });
    qc.invalidateQueries({ queryKey: ['analytics-vehicle-types'] });
    qc.invalidateQueries({ queryKey: ['analytics-staff-kpi'] });
    qc.invalidateQueries({ queryKey: ['analytics-seasonal'] });
    qc.invalidateQueries({ queryKey: ['analytics-dashboard'] });
    qc.invalidateQueries({ queryKey: ['anpr-stats'] });
  };

  const kpis = [
    { label: 'Total Cars', value: stats?.total_cars ?? 0, icon: Car, color: 'var(--text-accent)', bg: 'rgba(96,165,250,0.12)', trend: undefined, trendUp: true, sub: `Last ${days} days` },
    { label: 'Avg Duration', value: `${Math.round(stats?.avg_duration_minutes ?? 0)}m`, icon: Clock, color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)', trend: undefined, trendUp: false, sub: 'Per visit average' },
    { label: 'Revenue', value: `QAR ${(stats?.total_revenue ?? 0).toLocaleString()}`, icon: DollarSign, color: 'var(--text-purple)', bg: 'rgba(196,181,253,0.12)', trend: undefined, trendUp: true, sub: `Last ${days} days` },
    { label: 'Peak Hour', value: `${stats?.peak_hour ?? 0}:00`, icon: Activity, color: 'var(--text-success)', bg: 'rgba(110,231,183,0.12)', trend: undefined, sub: 'Busiest time of day' },
    { label: 'Completion Rate', value: `${completionRate}%`, icon: Target, color: '#34d399', bg: 'rgba(52,211,153,0.12)', trend: undefined, sub: 'Visits completed' },
    { label: 'Avg Revenue/Visit', value: stats?.total_cars ? `QAR ${Math.round((stats.total_revenue || 0) / stats.total_cars)}` : 'QAR 0', icon: TrendingUp, color: '#f472b6', bg: 'rgba(244,114,182,0.12)', trend: undefined, sub: 'Per vehicle' },
  ];

  const activeTabData =
    activeTab === 'services' ? serviceDuration
      : activeTab === 'staff' ? staffKpi
      : activeTab === 'seasonal' ? seasonal
      : activeTab === 'intelligence'
        ? smartInsights.map((s, i) => ({ rank: i + 1, tone: s.tone, title: s.title, detail: s.detail, action: s.action?.label ?? '' }))
        : daily;
  const activeTabName =
    activeTab === 'services' ? 'service-duration'
      : activeTab === 'staff' ? 'staff-kpi'
      : activeTab === 'seasonal' ? 'seasonal'
      : activeTab === 'intelligence' ? 'ai-insights'
      : 'daily-traffic';

  const liveOps = [
    { label: 'Cars today', value: dashboard?.total_cars_today ?? '—', icon: Car, link: '/' },
    { label: 'In shop now', value: dashboard?.cars_in_shop ?? '—', icon: Gauge, link: '/visits' },
    { label: 'Revenue today', value: dashboard != null ? `QAR ${Number(dashboard.total_revenue_today || 0).toLocaleString()}` : '—', icon: DollarSign, link: '/visits' },
    { label: 'ANPR reads today', value: dashboard?.anpr_detected_today ?? anprSnap?.today_detections ?? '—', icon: ScanLine, link: '/visionflow' },
  ];

  return (
    <div className="animate-fade-in">
      <style>{`
        .analytics-print-root { display: none !important; }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.65;transform:scale(0.92)} }
        @keyframes analytics-hero-shimmer { 0%{background-position:0% 50%} 100%{background-position:200% 50%} }
        @media print {
          @page { margin: 11mm; }
          html, body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          aside.sidebar { display: none !important; }
          .app-main > div:first-child { display: none !important; }
          .page-container { padding: 6px !important; max-width: none !important; }
          .analytics-screen-ui { display: none !important; }
          .analytics-print-root {
            display: block !important;
            visibility: visible !important;
          }
        }
      `}</style>
      <div className="analytics-screen-ui">
      {/* Hero */}
      <div style={{
        position: 'relative',
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 22,
        border: '1px solid var(--border-light)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.09) 0%, rgba(139,92,246,0.08) 45%, rgba(16,185,129,0.05) 100%)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(110deg, transparent 35%, rgba(255,255,255,0.04) 50%, transparent 65%)',
          backgroundSize: '200% 100%',
          animation: 'analytics-hero-shimmer 12s ease infinite',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'absolute', top: -60, right: -20, width: 280, height: 280, borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 65%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: -40, left: '10%', width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(16,185,129,0.08) 0%, transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', padding: '26px 28px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 52, height: 52, borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.35), rgba(139,92,246,0.25))',
                border: '1px solid rgba(139,92,246,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 12px 40px rgba(59,130,246,0.2)',
              }}>
                <BarChart3 size={26} color="#e0e7ff" />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                  <h1 className="page-title" style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Analytics & intelligence</h1>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em',
                    padding: '5px 12px', borderRadius: 99,
                    background: 'rgba(16,185,129,0.15)', color: '#34d399', border: '1px solid rgba(16,185,129,0.35)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', animation: 'pulse 2s ease infinite' }} />
                    Live data
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 560, lineHeight: 1.6 }}>
                  Unified metrics from visits, services, staff — synced with <strong style={{ color: 'var(--text-primary)' }}>Dashboard</strong> operations and{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>VisionFlow ANPR</strong>. Smart signals highlight what matters next.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={refreshAll} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Sync all
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => exportAnalyticsCSV(activeTabData || [], activeTabName)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Download size={14} /> Export
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => window.print()}
                title="Opens print dialog with a full multi-section analytics report (PDF or paper)"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Printer size={14} /> Print report
              </button>
              <div style={{ display: 'flex', gap: 4, background: 'var(--bg-elevated)', padding: 5, borderRadius: 12, border: '1px solid var(--border)' }}>
                {[7, 14, 30, 90].map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    style={{
                      padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 800,
                      cursor: 'pointer', border: 'none', transition: 'all 0.15s',
                      background: days === d ? 'linear-gradient(135deg, rgba(59,130,246,0.35), rgba(139,92,246,0.2))' : 'transparent',
                      color: days === d ? '#fff' : 'var(--text-muted)',
                      boxShadow: days === d ? '0 4px 14px rgba(59,130,246,0.35)' : 'none',
                    }}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Quick navigation — app-wide */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 22 }}>
            {[
              { to: '/', label: 'Dashboard', icon: LayoutDashboard },
              { to: '/visits', label: 'Visits', icon: Car },
              { to: '/vehicles', label: 'Vehicles', icon: Zap },
              { to: '/services', label: 'Services', icon: Wrench },
              { to: '/visionflow', label: 'ANPR & speed', icon: Gauge },
              { to: '/visionflow/history', label: 'Analysis history', icon: ScanLine },
            ].map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', borderRadius: 10,
                  background: 'var(--bg-surface)', border: '1px solid var(--border-light)',
                  color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600,
                  textDecoration: 'none', transition: 'border-color 0.15s, color 0.15s',
                }}
              >
                <Icon size={14} color="var(--text-accent)" /> {label}
                <ChevronRight size={14} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Live ops strip — same signals as Dashboard */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 22,
      }}>
        {liveOps.map(({ label, value, icon: Icon, link }) => (
          <Link
            key={label}
            to={link}
            style={{
              textDecoration: 'none',
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 18px', borderRadius: 14,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
              transition: 'transform 0.18s ease, border-color 0.18s, box-shadow 0.18s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.borderColor = 'rgba(129,140,248,0.35)';
              e.currentTarget.style.boxShadow = '0 10px 28px rgba(0,0,0,0.18)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = '';
              e.currentTarget.style.borderColor = '';
              e.currentTarget.style.boxShadow = '';
            }}
          >
            <div style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={18} color="var(--text-accent)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
              <div style={{ fontSize: 17, fontWeight: 900, color: 'var(--text-primary)', marginTop: 2 }}>{value}</div>
            </div>
            <ArrowRight size={16} color="var(--text-muted)" />
          </Link>
        ))}
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap',
        background: 'var(--bg-elevated)', borderRadius: 14, padding: 5,
        border: '1px solid var(--border-light)',
      }}>
        {([
          { id: 'overview' as const, label: 'Overview', icon: BarChart2 },
          { id: 'intelligence' as const, label: 'AI insights', icon: Brain },
          { id: 'services' as const, label: 'Services', icon: Wrench },
          { id: 'staff' as const, label: 'Staff KPIs', icon: UsersIcon },
          { id: 'seasonal' as const, label: 'Seasonal', icon: Calendar },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '10px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700,
              border: 'none', cursor: 'pointer', transition: 'all 0.18s',
              background: activeTab === id ? 'linear-gradient(135deg, rgba(59,130,246,0.28), rgba(139,92,246,0.18))' : 'transparent',
              color: activeTab === id ? '#fff' : 'var(--text-muted)',
              boxShadow: activeTab === id ? '0 6px 20px rgba(59,130,246,0.25)' : 'none',
            }}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {/* Smart insight ribbon */}
      {smartInsights.length > 0 && activeTab !== 'intelligence' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
          marginBottom: 22,
        }}>
          {smartInsights.slice(0, 4).map((ins, idx) => {
            const st = INSIGHT_STYLE[ins.tone];
            const Icon = st.icon;
            return (
              <div
                key={idx}
                style={{
                  position: 'relative',
                  padding: '16px 18px',
                  borderRadius: 16,
                  background: `linear-gradient(165deg, var(--bg-surface), ${st.glow})`,
                  border: `1px solid ${st.border}`,
                  overflow: 'hidden',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 11,
                    background: 'var(--bg-elevated)', border: `1px solid ${st.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Icon size={18} color="#a78bfa" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>
                      {ins.tone === 'ai' ? 'AI signal' : ins.tone === 'growth' ? 'Growth' : ins.tone === 'watch' ? 'Watch' : 'Operations'}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6, lineHeight: 1.35 }}>{ins.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{ins.detail}</div>
                    {ins.action && (
                      <Link to={ins.action.to} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--text-accent)', textDecoration: 'none' }}>
                        {ins.action.label} <ArrowRight size={13} />
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 14,
        marginBottom: 24,
      }}>
        {kpis.map(kpi => <KPICard key={kpi.label} {...kpi} />)}
      </div>

      {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
      {activeTab === 'overview' && <>

      {/* Daily Traffic + Revenue */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 20, marginBottom: 20 }}>
        <div className="card card-p" style={{ borderRadius: 16, border: '1px solid var(--border-light)' }}>
          <div className="card-header">
            <div>
              <div className="card-title">Daily traffic & revenue</div>
              <div className="card-subtitle">Cars served and revenue per day — composition-ready for ops reviews</div>
            </div>
            <div className="info-chip"><Calendar size={12} /> {days} days</div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={daily || []} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                tickFormatter={d => { try { return fmtQatar(new Date(`${d}T12:00:00+03:00`), 'md'); } catch { return String(d); } }}
                axisLine={false} tickLine={false} />
              <YAxis yAxisId="left" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)', paddingTop: 12 }} />
              <Bar yAxisId="left" dataKey="count" name="Cars" fill="#6366f1" radius={[6, 6, 0, 0]} maxBarSize={36} />
              <Bar yAxisId="right" dataKey="revenue" name="Revenue (QAR)" fill="#a78bfa" radius={[6, 6, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Service distribution — redesigned */}
      <div style={{ marginBottom: 20 }}>
        <ServiceDistributionPanel services={services} days={days} />
      </div>

      {/* Peak hours */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 20, marginBottom: 20 }}>
        <div className="card card-p" style={{ borderRadius: 16, border: '1px solid var(--border-light)' }}>
          <div className="card-header">
            <div>
              <div className="card-title">Peak hours</div>
              <div className="card-subtitle">Arrival intensity by clock hour — staff to bays</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hourly || []} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" vertical={false} />
              <XAxis dataKey="hour" tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                tickFormatter={h => `${h}:00`} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(59,130,246,0.06)' }} />
              <Bar dataKey="count" name="Cars" radius={[6, 6, 0, 0]} maxBarSize={32}>
                {(hourly || []).map((_: any, i: number) => {
                  const max = Math.max(...(hourly || []).map((h: any) => h.count), 1);
                  const intensity = (hourly || [])[i]?.count / max;
                  const r = Math.round(99 + (129 - 99) * intensity);
                  const g = Math.round(102 + (140 - 102) * intensity);
                  const b = Math.round(241 + (199 - 241) * intensity);
                  return <Cell key={i} fill={`rgb(${r},${g},${b})`} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Service Revenue Table */}
      {(services || []).length > 0 && (
        <div className="card" style={{ overflow: 'hidden', borderRadius: 16, border: '1px solid var(--border-light)' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-light)' }}>
            <div className="card-title">Revenue by service</div>
            <div className="card-subtitle">Line counts, averages, and revenue share — ties to the distribution chart above</div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
                  <th>#</th>
                  <th>Service</th>
                  <th>Count</th>
                  <th>Revenue</th>
                  <th>Avg Price</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {(services || []).map((svc: any, i: number) => {
                  const total = (services || []).reduce((s: number, x: any) => s + (x.total_revenue || 0), 0);
                  const share = total ? Math.round((svc.total_revenue / total) * 100) : 0;
                  return (
                    <tr key={i}>
                      <td>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS[i % COLORS.length], display: 'inline-block', marginRight: 10 }} />
                        <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{i + 1}</span>
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{svc.service_name}</td>
                      <td><span className="badge badge-blue">{svc.count}</span></td>
                      <td style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {(svc.total_revenue || 0).toLocaleString()}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>
                        QAR {svc.count ? Math.round(svc.total_revenue / svc.count).toLocaleString() : 0}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'var(--bg-elevated)', maxWidth: 100 }}>
                            <div style={{ width: `${share}%`, height: '100%', borderRadius: 99, background: COLORS[i % COLORS.length] }} />
                          </div>
                          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 28 }}>{share}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Vehicle Type Breakdown */}
      {(vehicleTypes || []).length > 0 && (
        <div className="card" style={{ marginTop: 20, overflow: 'hidden' }}>
          <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-light)' }}>
            <div className="card-title">Revenue by Vehicle Type</div>
            <div className="card-subtitle">Which vehicle types generate the most revenue</div>
          </div>
          <div style={{ padding: '16px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            {(vehicleTypes || []).map((vt: any, i: number) => (
              <div key={vt.vehicle_type} style={{
                padding: '14px', borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
                textAlign: 'center',
                transition: 'transform 0.15s, border-color 0.15s',
              }}>
                <div style={{
                  width: 44,
                  height: 44,
                  margin: '0 auto 10px',
                  borderRadius: 12,
                  background: `${COLORS[i % COLORS.length]}18`,
                  border: `1px solid ${COLORS[i % COLORS.length]}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: COLORS[i % COLORS.length],
                }}>
                  <VehicleTypeGlyph type={vt.vehicle_type} />
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize', marginBottom: 4 }}>
                  {vt.vehicle_type}
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: COLORS[i % COLORS.length] }}>{vt.count}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>visits</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-purple)' }}>QAR {vt.avg_revenue}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>avg/visit</div>
                {vt.avg_duration_minutes > 0 && (
                  <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--text-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                    <Clock size={9} /> {vt.avg_duration_minutes}m avg
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      </> /* end overview */}

      {/* ── INTELLIGENCE TAB ─────────────────────────────────────────── */}
      {activeTab === 'intelligence' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div className="card card-p" style={{
            border: '1px solid rgba(139,92,246,0.28)',
            background: 'linear-gradient(165deg, var(--bg-surface) 0%, rgba(139,92,246,0.06) 100%)',
          }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 14,
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(59,130,246,0.2))',
                  border: '1px solid rgba(139,92,246,0.35)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Brain size={24} color="#e9d5ff" />
                </div>
                <div>
                  <div className="card-title">AI · smart signals</div>
                  <div className="card-subtitle">
                    Interpretations generated from CarTrack metrics and ANPR activity — processed in your browser and API; ideal for daily stand-ups and shift briefings.
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {smartInsights.map((ins, idx) => {
                const st = INSIGHT_STYLE[ins.tone];
                const Icon = st.icon;
                return (
                  <div
                    key={idx}
                    style={{
                      padding: '18px 20px', borderRadius: 16,
                      border: `1px solid ${st.border}`,
                      background: `linear-gradient(145deg, var(--bg-elevated), ${st.glow})`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <Sparkles size={14} color="var(--text-purple)" />
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                        {ins.tone === 'ai' ? 'Neural hint' : ins.tone === 'growth' ? 'Momentum' : ins.tone === 'watch' ? 'Attention' : 'Throughput'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                        background: 'var(--bg-base)', border: `1px solid ${st.border}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Icon size={17} color="var(--text-accent)" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.35 }}>{ins.title}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{ins.detail}</div>
                        {ins.action && (
                          <Link to={ins.action.to} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12.5, fontWeight: 700, color: 'var(--text-accent)' }}>
                            {ins.action.label} <ChevronRight size={14} />
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
            <div className="card card-p">
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ScanLine size={18} color="#06b6d4" /> ANPR sync health
              </div>
              <div className="card-subtitle">VisionFlow camera reads ↔ vehicle registry</div>
              <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Detections today</span>
                  <strong>{anprSnap?.today_detections ?? '—'}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Unique plates today</span>
                  <strong>{anprSnap?.today_unique_plates ?? '—'}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Avg speed (km/h)</span>
                  <strong>{anprSnap?.avg_speed_kmh != null ? anprSnap.avg_speed_kmh : '—'}</strong>
                </div>
                <div style={{ padding: 12, borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Lifetime linkage</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#34d399' }}>
                    {anprSnap?.total_synced
                      ? `${Math.round(((anprSnap.linked_to_vehicle ?? 0) / anprSnap.total_synced) * 100)}%`
                      : '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    {anprSnap?.linked_to_vehicle ?? 0} / {anprSnap?.total_synced ?? 0} reads tied to a vehicle
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Link to="/visionflow" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>Open analyzer</Link>
                <Link to="/visionflow/history" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>History</Link>
              </div>
            </div>

            <div className="card card-p">
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Activity size={18} color="var(--text-accent)" /> Operations mesh
              </div>
              <div className="card-subtitle">Cross-links across CarTrack modules</div>
              <ul style={{ margin: '14px 0 0', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.75 }}>
                <li><Link to="/" style={{ color: 'var(--text-accent)', fontWeight: 600 }}>Dashboard</Link> shows live bays — matches “In shop” above.</li>
                <li><Link to="/visits" style={{ color: 'var(--text-accent)', fontWeight: 600 }}>Visits</Link> is the source for revenue &amp; duration charts.</li>
                <li><Link to="/visionflow" style={{ color: 'var(--text-accent)', fontWeight: 600 }}>ANPR &amp; speed</Link> feeds pending linkage insights.</li>
                <li><Link to="/services" style={{ color: 'var(--text-accent)', fontWeight: 600 }}>Services</Link> catalogue drives mix &amp; margin views.</li>
              </ul>
            </div>
          </div>

          <div className="card card-p">
            <div className="card-header">
              <div>
                <div className="card-title">Today · visits vs ANPR reads by hour</div>
                <div className="card-subtitle">Overlay shop traffic with camera detection volume (UTC-local server day)</div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={hourly || []} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" vertical={false} />
                <XAxis dataKey="hour" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} tickFormatter={h => `${h}:00`} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }} />
                <Bar yAxisId="left" dataKey="count" name="Shop visits" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line yAxisId="right" type="monotone" dataKey="anpr" name="ANPR reads" stroke="#a78bfa" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── SERVICES TAB ─────────────────────────────────────────────── */}
      {activeTab === 'services' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Service Duration Analysis */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-light)' }}>
              <div className="card-title">Service Duration Analysis</div>
              <div className="card-subtitle">Estimated vs actual time taken per service</div>
            </div>
            {!(serviceDuration || []).length ? (
              <div className="empty-state" style={{ padding: 60 }}>
                <Clock size={36} /><h3>No timing data yet</h3>
                <p>Start and complete services to see duration analysis</p>
              </div>
            ) : (
              <div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>Category</th>
                        <th>Count</th>
                        <th>Est. Duration</th>
                        <th>Avg Actual</th>
                        <th>Efficiency</th>
                        <th>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(serviceDuration || []).map((s: any, i: number) => {
                        const eff = s.efficiency;
                        const effColor = eff === null ? '#9ca3af' : eff >= 100 ? 'var(--text-success)' : eff >= 80 ? 'var(--text-warning)' : 'var(--text-danger)';
                        return (
                          <tr key={i}>
                            <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{s.service_name}</td>
                            <td><span className="badge badge-gray" style={{ textTransform: 'capitalize', fontSize: 10 }}>{s.category}</span></td>
                            <td><span className="badge badge-blue">{s.count}</span></td>
                            <td style={{ color: 'var(--text-secondary)' }}>{s.estimated_duration}m</td>
                            <td style={{ fontWeight: 600, color: (s.avg_actual_minutes || s.avg_actual_duration) ? 'var(--text-warning)' : 'var(--text-muted)' }}>
                              {(s.avg_actual_minutes || s.avg_actual_duration) ? `${s.avg_actual_minutes || s.avg_actual_duration}m` : '—'}
                            </td>
                            <td>
                              {eff !== null ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ flex: 1, height: 6, borderRadius: 99, background: 'var(--bg-elevated)', maxWidth: 80 }}>
                                    <div style={{ width: `${Math.min(eff, 100)}%`, height: '100%', borderRadius: 99, background: effColor, transition: 'width 0.5s' }} />
                                  </div>
                                  <span style={{ fontSize: 11, color: effColor, fontWeight: 700 }}>{eff}%</span>
                                </div>
                              ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No data</span>}
                            </td>
                            <td style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {(s.total_revenue || 0).toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Duration Bar Chart */}
                <div style={{ padding: '20px 24px', borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, fontWeight: 600 }}>ESTIMATED vs ACTUAL DURATION</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={serviceDuration || []} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,66,0.4)" vertical={false} />
                      <XAxis dataKey="service_name" tick={{ fill: '#484f58', fontSize: 9 }}
                        tickFormatter={s => s.split(' ')[0]} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#484f58', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }} />
                      <Bar dataKey="estimated_duration" name="Estimated (min)" fill="#6b7280" radius={[4,4,0,0]} maxBarSize={28} />
                      <Bar dataKey="avg_actual_minutes" name="Actual (min)" fill="#f59e0b" radius={[4,4,0,0]} maxBarSize={28} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>

          {/* Revenue by Service table same as overview */}
          {(services || []).length > 0 && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-light)' }}>
                <div className="card-title">Revenue by Service</div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>Service</th><th>Count</th><th>Revenue</th><th>Avg</th><th>Share</th></tr>
                  </thead>
                  <tbody>
                    {(services || []).map((svc: any, i: number) => {
                      const total = (services || []).reduce((s: number, x: any) => s + (x.total_revenue || 0), 0);
                      const share = total ? Math.round((svc.total_revenue / total) * 100) : 0;
                      return (
                        <tr key={i}>
                          <td><div style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS[i % COLORS.length], display: 'inline-block', marginRight: 10 }} /><span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{i+1}</span></td>
                          <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{svc.service_name}</td>
                          <td><span className="badge badge-blue">{svc.count}</span></td>
                          <td style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {(svc.total_revenue || 0).toLocaleString()}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>QAR {svc.count ? Math.round(svc.total_revenue / svc.count) : 0}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'var(--bg-elevated)', maxWidth: 80 }}>
                                <div style={{ width: `${share}%`, height: '100%', borderRadius: 99, background: COLORS[i % COLORS.length] }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 28 }}>{share}%</span>
                            </div>
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
      )}

      {/* ── STAFF KPI TAB ────────────────────────────────────────────── */}
      {activeTab === 'staff' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!(staffKpi || []).length ? (
            <div className="card empty-state" style={{ padding: 80 }}>
              <UsersIcon size={40} />
              <h3>No staff performance data</h3>
              <p>Assign staff to services and mark them complete to see KPIs</p>
            </div>
          ) : (
            <>
              {/* Top staff cards */}
              <div className="grid-4">
                {(staffKpi || []).slice(0, 4).map((s: any, i: number) => (
                  <div key={s.staff_id} className="stat-card" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 10,
                        background: `linear-gradient(135deg, ${COLORS[i]}, ${COLORS[(i+2)%COLORS.length]})`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 800, color: 'white', flexShrink: 0,
                      }}>
                        {s.staff_name?.charAt(0) || '?'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.staff_name}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>@{s.username}</div>
                      </div>
                      {i === 0 && <Award size={14} color="var(--text-warning)" />}
                    </div>
                    <div className="staff-metric-row" style={{ paddingTop: 6, borderTop: '1px solid var(--border-light)', width: '100%' }}>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: COLORS[i % COLORS.length] }}>{s.services_count}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Services</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-purple)' }}>QAR {(s.total_revenue || 0).toLocaleString()}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Revenue</div>
                      </div>
                      {s.avg_service_duration && (
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-warning)' }}>{s.avg_service_duration}m</div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Avg Time</div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Staff performance chart */}
              <div className="card card-p">
                <div className="card-header">
                  <div>
                    <div className="card-title">Services Completed per Staff</div>
                    <div className="card-subtitle">Performance comparison</div>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={staffKpi || []} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,66,0.4)" vertical={false} />
                    <XAxis dataKey="staff_name" tick={{ fill: '#484f58', fontSize: 10 }}
                      tickFormatter={n => n.split(' ')[0]} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#484f58', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="services_count" name="Services" radius={[4,4,0,0]} maxBarSize={40}>
                      {(staffKpi || []).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Full KPI Table */}
              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-light)' }}>
                  <div className="card-title">Full Staff KPI Table</div>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Staff</th>
                        <th>Services</th>
                        <th>Revenue</th>
                        <th>Avg Duration</th>
                        <th>Top Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(staffKpi || []).map((s: any, i: number) => {
                        const topCat = s.service_breakdown ? Object.entries(s.service_breakdown).sort((a: any, b: any) => b[1] - a[1])[0] : null;
                        return (
                          <tr key={s.staff_id}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {i < 3 && <span style={{ fontSize: 16 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}</span>}
                                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: 12 }}>#{i+1}</span>
                              </div>
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                                <div style={{
                                  width: 28, height: 28, borderRadius: 7,
                                  background: `linear-gradient(135deg, ${COLORS[i % COLORS.length]}, ${COLORS[(i+2) % COLORS.length]})`,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 12, fontWeight: 800, color: 'white',
                                }}>
                                  {s.staff_name?.charAt(0)}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{s.staff_name}</div>
                                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>@{s.username}</div>
                                </div>
                              </div>
                            </td>
                            <td><span className="badge badge-blue" style={{ fontSize: 12, fontWeight: 800 }}>{s.services_count}</span></td>
                            <td style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {(s.total_revenue || 0).toLocaleString()}</td>
                            <td style={{ color: s.avg_service_duration ? 'var(--text-warning)' : 'var(--text-muted)', fontWeight: 600 }}>
                              {s.avg_service_duration ? `${s.avg_service_duration}m` : '—'}
                            </td>
                            <td>
                              {topCat ? (
                                <span className="badge badge-cyan" style={{ textTransform: 'capitalize', fontSize: 10 }}>
                                  {String(topCat[0])} ({String(topCat[1])})
                                </span>
                              ) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── SEASONAL TAB ─────────────────────────────────────────────── */}
      {activeTab === 'seasonal' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card card-p">
            <div className="card-header">
              <div>
                <div className="card-title">Monthly Revenue — {qatarYearNow()}</div>
                <div className="card-subtitle">Seasonal trends for the current year</div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={seasonal || []} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,66,0.4)" vertical={false} />
                <XAxis dataKey="month_name" tick={{ fill: '#484f58', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fill: '#484f58', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fill: '#484f58', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }} />
                <Bar yAxisId="left" dataKey="count" name="Cars" fill="#3b82f6" radius={[4,4,0,0]} maxBarSize={30} />
                <Bar yAxisId="right" dataKey="revenue" name="Revenue" fill="#8b5cf6" radius={[4,4,0,0]} maxBarSize={30} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Avg duration by month */}
          <div className="card card-p">
            <div className="card-header">
              <div>
                <div className="card-title">Monthly Avg Visit Duration</div>
                <div className="card-subtitle">How long vehicles stay on average each month</div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={seasonal || []} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="durGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,66,0.4)" vertical={false} />
                <XAxis dataKey="month_name" tick={{ fill: '#484f58', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#484f58', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area dataKey="avg_duration" name="Avg Duration (min)" stroke="#f59e0b" fill="url(#durGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Monthly table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-light)' }}>
              <div className="card-title">Monthly Breakdown</div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Month</th><th>Cars</th><th>Revenue</th><th>Avg Duration</th><th>Trend</th></tr>
                </thead>
                <tbody>
                  {(seasonal || []).map((m: any, i: number) => {
                    const prev = (seasonal || [])[i - 1];
                    const trend = prev && prev.count > 0 ? Math.round(((m.count - prev.count) / prev.count) * 100) : null;
                    return (
                      <tr key={m.month} style={{ opacity: m.count === 0 ? 0.45 : 1 }}>
                        <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.month_name}</td>
                        <td><span className="badge badge-blue">{m.count}</span></td>
                        <td style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {(m.revenue || 0).toLocaleString()}</td>
                        <td style={{ color: m.avg_duration ? 'var(--text-warning)' : 'var(--text-muted)' }}>
                          {m.avg_duration ? `${m.avg_duration}m` : '—'}
                        </td>
                        <td>
                          {trend !== null ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: trend >= 0 ? 'var(--text-success)' : 'var(--text-danger)' }}>
                              {trend >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                              {Math.abs(trend)}%
                            </div>
                          ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      </div>

      <AnalyticsPrintReport
        days={days}
        stats={stats as Record<string, unknown> | undefined}
        dashboard={dashboard as Record<string, unknown> | undefined}
        daily={daily}
        hourly={hourly as { hour?: number; count?: number; anpr?: number }[] | undefined}
        services={services}
        serviceDuration={serviceDuration}
        vehicleTypes={vehicleTypes}
        staffKpi={staffKpi}
        seasonal={seasonal}
        smartInsights={smartInsights}
        anprSnap={anprSnap as Record<string, unknown> | undefined}
        completionRate={completionRate}
      />
    </div>
  );
};
