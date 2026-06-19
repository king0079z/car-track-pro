import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  X, Car, Clock, DollarSign, Calendar, Wrench, TrendingUp,
  ExternalLink, Loader2, User, Hash,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { vehiclesApi } from '../../services/api';
import { fmtQatar } from '../../lib/qatarTime';

export interface TodayCompletedJob {
  visit_id: number;
  visit_number: string;
  vehicle_id: number;
  plate_number: string;
  vehicle_type: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  duration_minutes?: number | null;
  amount_paid: number;
  total_visits: number;
  owner_name?: string | null;
}

function fmtDur(m: number | null | undefined): string {
  if (!m || m <= 0) return '—';
  const rounded = Math.round(m);
  if (rounded < 60) return `${rounded}m`;
  return `${Math.floor(rounded / 60)}h ${rounded % 60}m`;
}

function vehicleLabel(job: TodayCompletedJob): string {
  const parts = [job.make, job.model].filter(Boolean);
  if (job.year) parts.push(String(job.year));
  return parts.length ? parts.join(' ') : job.vehicle_type.replace(/_/g, ' ');
}

const TYPE_LABELS: Record<string, string> = {
  sedan: 'Sedan', suv: 'SUV', truck: 'Truck', van: 'Van', motorcycle: 'Motorcycle', other: 'Other',
};

interface Props {
  job: TodayCompletedJob;
  onClose: () => void;
}

export const TodayOpsVehicleModal: React.FC<Props> = ({ job, onClose }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['vehicle-history-modal', job.vehicle_id],
    queryFn: () => vehiclesApi.history(job.vehicle_id).then(r => r.data),
  });

  const visits = data?.visits ?? [];
  const summary = data?.summary;

  const spendChart = useMemo(() => {
    const rows = [...visits]
      .sort((a: { entry_time: string }, b: { entry_time: string }) =>
        new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime())
      .slice(-12)
      .map((v: { entry_time: string; total_price?: number; visit_number?: string }) => ({
        label: fmtQatar(v.entry_time, 'dateMed'),
        full: fmtQatar(v.entry_time, 'full'),
        amount: v.total_price ?? 0,
        visit: v.visit_number,
      }));
    return rows;
  }, [visits]);

  const allServices = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    for (const v of visits) {
      for (const s of v.services ?? []) {
        const name = s.service_name || 'Service';
        const cur = map.get(name) ?? { count: 0, total: 0 };
        cur.count += 1;
        cur.total += s.price ?? 0;
        map.set(name, cur);
      }
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [visits]);

  return (
    <div className="dash-ops-modal-backdrop" onClick={onClose} role="presentation">
      <div className="dash-ops-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dash-ops-modal-head">
          <div className="dash-ops-modal-plate-row">
            <span className="dash-ops-modal-plate">{job.plate_number}</span>
            <span className="dash-ops-modal-type">
              {TYPE_LABELS[job.vehicle_type] ?? job.vehicle_type}
            </span>
          </div>
          <h2>{vehicleLabel(job)}</h2>
          {job.owner_name && (
            <div className="dash-ops-modal-owner"><User size={12} /> {job.owner_name}</div>
          )}
          <button type="button" className="dash-ops-modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="dash-ops-modal-kpis">
          <div className="dash-ops-modal-kpi">
            <Hash size={14} />
            <div>
              <strong>{summary?.total_visits ?? job.total_visits}</strong>
              <span>Shop visits</span>
            </div>
          </div>
          <div className="dash-ops-modal-kpi">
            <DollarSign size={14} />
            <div>
              <strong>QAR {(summary?.total_spent ?? job.amount_paid).toLocaleString()}</strong>
              <span>Total spent</span>
            </div>
          </div>
          <div className="dash-ops-modal-kpi">
            <Clock size={14} />
            <div>
              <strong>{fmtDur(summary?.avg_duration_minutes ?? job.duration_minutes)}</strong>
              <span>Avg duration</span>
            </div>
          </div>
          <div className="dash-ops-modal-kpi accent">
            <TrendingUp size={14} />
            <div>
              <strong>QAR {job.amount_paid.toLocaleString()}</strong>
              <span>Today&apos;s job</span>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="dash-ops-modal-loading">
            <Loader2 size={28} className="spin" />
            <span>Loading vehicle history…</span>
          </div>
        ) : (
          <div className="dash-ops-modal-body">
            <section className="dash-ops-modal-section">
              <div className="dash-ops-modal-section-title">
                <TrendingUp size={14} /> Spending history
              </div>
              {spendChart.length === 0 ? (
                <p className="dash-ops-modal-empty">No visit history yet.</p>
              ) : (
                <div className="dash-ops-modal-chart">
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={spendChart} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(75,85,99,0.15)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload as { full: string; amount: number; visit: string };
                          return (
                            <div className="dash-ops-tooltip">
                              <div className="dash-ops-tooltip-title">{p.visit}</div>
                              <div>{p.full}</div>
                              <div><strong>QAR {p.amount.toLocaleString()}</strong></div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="amount" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className="dash-ops-modal-section">
              <div className="dash-ops-modal-section-title">
                <Wrench size={14} /> All services provided
              </div>
              {allServices.length === 0 ? (
                <p className="dash-ops-modal-empty">No service records.</p>
              ) : (
                <div className="dash-ops-modal-services">
                  {allServices.map(s => (
                    <div key={s.name} className="dash-ops-modal-svc-row">
                      <span className="dash-ops-modal-svc-name">{s.name}</span>
                      <span className="dash-ops-modal-svc-meta">{s.count}×</span>
                      <span className="dash-ops-modal-svc-amt">QAR {s.total.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="dash-ops-modal-section">
              <div className="dash-ops-modal-section-title">
                <Calendar size={14} /> Visit history
              </div>
              <div className="dash-ops-modal-visits">
                {visits.map((v: {
                  id: number;
                  visit_number: string;
                  entry_time: string;
                  duration_minutes?: number;
                  total_price?: number;
                  status: string;
                  services?: { service_name: string; price?: number }[];
                }) => (
                  <div key={v.id} className={`dash-ops-modal-visit${v.id === job.visit_id ? ' today' : ''}`}>
                    <div className="dash-ops-modal-visit-top">
                      <span className="dash-ops-modal-visit-wo">{v.visit_number}</span>
                      {v.id === job.visit_id && <span className="dash-ops-modal-today-badge">Today</span>}
                      <span className="dash-ops-modal-visit-date">{fmtQatar(v.entry_time, 'full')}</span>
                      <span className="dash-ops-modal-visit-dur">{fmtDur(v.duration_minutes)}</span>
                      <span className="dash-ops-modal-visit-amt">QAR {(v.total_price ?? 0).toLocaleString()}</span>
                    </div>
                    {(v.services?.length ?? 0) > 0 && (
                      <div className="dash-ops-modal-visit-svcs">
                        {v.services!.map((s, i) => (
                          <span key={i} className="dash-ops-modal-visit-svc-chip">
                            {s.service_name}
                            {s.price != null ? ` · QAR ${s.price}` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        <div className="dash-ops-modal-foot">
          <Link to={`/vehicles/${job.vehicle_id}`} className="btn btn-secondary btn-sm" onClick={onClose}>
            <Car size={13} /> Full vehicle profile
          </Link>
          <Link to={`/visits/${job.visit_id}`} className="btn btn-primary btn-sm" onClick={onClose}>
            <ExternalLink size={13} /> Today&apos;s work order
          </Link>
        </div>
      </div>
    </div>
  );
};
