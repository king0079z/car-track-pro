import React, { useMemo, useState } from 'react';

import { Link } from 'react-router-dom';

import { useQuery } from '@tanstack/react-query';

import {

  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,

} from 'recharts';

import {

  DollarSign, Timer, CheckCircle2, TrendingUp, ArrowRight, Wrench,

  Car, ChevronRight,

} from 'lucide-react';

import { analyticsApi } from '../../services/api';

import { TodayOpsVehicleModal, type TodayCompletedJob } from './TodayOpsVehicleModal';



interface TodayService {

  service_name: string;

  count: number;

  total_revenue: number;

  avg_minutes: number;

  estimated_minutes: number;

  vs_estimate_pct: number;

}



interface TodayOps {

  total_revenue_today: number;

  pipeline_revenue: number;

  avg_service_minutes: number;

  completed_today: number;

  service_lines_today: number;

  services: TodayService[];

  completed_jobs: TodayCompletedJob[];

}



type OpsPanel = 'services' | 'jobs';



function fmtDur(m: number | null | undefined): string {

  if (!m || m < 0) return '0m';

  const rounded = Math.round(m);

  if (rounded < 60) return `${rounded}m`;

  return `${Math.floor(rounded / 60)}h ${rounded % 60}m`;

}



function vehicleLabel(job: TodayCompletedJob): string {

  const parts = [job.make, job.model].filter(Boolean);

  if (job.year) parts.push(String(job.year));

  if (parts.length) return parts.join(' ');

  return (job.vehicle_type || 'vehicle').replace(/_/g, ' ');

}



const TYPE_LABELS: Record<string, string> = {

  sedan: 'Sedan', suv: 'SUV', truck: 'Truck', van: 'Van', motorcycle: 'Moto', other: 'Other',

};



const BAR_COLORS = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#a78bfa'];



const ChartTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: TodayService & { shortName: string } }> }> = ({

  active, payload,

}) => {

  if (!active || !payload?.length) return null;

  const p = payload[0].payload;

  return (

    <div className="dash-ops-tooltip">

      <div className="dash-ops-tooltip-title">{p.service_name}</div>

      <div>Revenue: <strong>QAR {p.total_revenue.toLocaleString()}</strong></div>

      <div>Jobs today: <strong>{p.count}</strong></div>

      <div>Avg time: <strong>{fmtDur(p.avg_minutes)}</strong> (est. {fmtDur(p.estimated_minutes)})</div>

    </div>

  );

};



export const DashboardTodayOps: React.FC = () => {

  const [panel, setPanel] = useState<OpsPanel>('services');

  const [selectedJob, setSelectedJob] = useState<TodayCompletedJob | null>(null);



  const { data: res, isLoading } = useQuery({

    queryKey: ['analytics-today-ops'],

    queryFn: () => analyticsApi.todayOps().then(r => r.data as TodayOps),

    refetchInterval: 45000,

  });



  const ops = res;

  const services = ops?.services ?? [];

  const completedJobs = ops?.completed_jobs ?? [];

  const maxRev = Math.max(...services.map(s => s.total_revenue), 1);



  const chartData = useMemo(

    () => services.slice(0, 6).map(s => ({

      ...s,

      shortName: s.service_name.length > 18 ? `${s.service_name.slice(0, 16)}…` : s.service_name,

    })),

    [services],

  );



  const totalRev = ops?.total_revenue_today ?? 0;

  const pipeline = ops?.pipeline_revenue ?? 0;

  const combinedRev = totalRev + pipeline;



  return (

    <>

      <div className="dash-ops-card">

        <div className="dash-ops-header">

          <div>

            <div className="dash-ops-kicker">Today&apos;s performance</div>

            <div className="dash-ops-title">Revenue &amp; service time</div>

          </div>

          <Link to="/analytics" className="btn btn-ghost btn-sm dash-ops-link">

            Full analytics <ArrowRight size={12} />

          </Link>

        </div>



        <div className="dash-ops-hero">

          <button

            type="button"

            className={`dash-ops-metric primary${panel === 'services' ? ' active' : ''}`}

            onClick={() => setPanel('services')}

          >

            <div className="dash-ops-metric-icon"><DollarSign size={18} /></div>

            <div>

              <div className="dash-ops-metric-value">QAR {totalRev.toLocaleString()}</div>

              <div className="dash-ops-metric-label">Earned today</div>

              {pipeline > 0 && (

                <div className="dash-ops-metric-sub">+ QAR {pipeline.toLocaleString()} in progress</div>

              )}

            </div>

          </button>

          <button

            type="button"

            className={`dash-ops-metric${panel === 'services' ? ' active' : ''}`}

            onClick={() => setPanel('services')}

          >

            <div className="dash-ops-metric-icon amber"><Timer size={18} /></div>

            <div>

              <div className="dash-ops-metric-value">{fmtDur(ops?.avg_service_minutes ?? 0)}</div>

              <div className="dash-ops-metric-label">Avg service time</div>

              <div className="dash-ops-metric-sub">Completed visits today</div>

            </div>

          </button>

          <button

            type="button"

            className={`dash-ops-metric${panel === 'jobs' ? ' active' : ''}`}

            onClick={() => setPanel('jobs')}

          >

            <div className="dash-ops-metric-icon green"><CheckCircle2 size={18} /></div>

            <div>

              <div className="dash-ops-metric-value">{ops?.completed_today ?? 0}</div>

              <div className="dash-ops-metric-label">Jobs completed</div>

              <div className="dash-ops-metric-sub">{ops?.service_lines_today ?? 0} service lines · tap to list</div>

            </div>

          </button>

        </div>



        {isLoading && (

          <div className="dash-ops-empty">Loading today&apos;s breakdown…</div>

        )}



        {!isLoading && panel === 'jobs' && (

          <div className="dash-ops-jobs-panel">

            <div className="dash-ops-jobs-head">

              <Car size={14} />

              <span>Completed today</span>

              <span className="dash-ops-jobs-count">{completedJobs.length}</span>

            </div>

            {completedJobs.length === 0 ? (

              <div className="dash-ops-empty compact">

                <CheckCircle2 size={20} strokeWidth={1.5} />

                <p>No completed jobs yet today.</p>

              </div>

            ) : (

              <div className="dash-ops-jobs-list">

                <div className="dash-ops-jobs-row head">

                  <span>Plate</span>

                  <span>Vehicle</span>

                  <span>Type</span>

                  <span>Duration</span>

                  <span>Paid</span>

                  <span>Visits</span>

                  <span />

                </div>

                {completedJobs.map(job => (

                  <button

                    key={job.visit_id}

                    type="button"

                    className="dash-ops-jobs-row"

                    onClick={() => setSelectedJob(job)}

                  >

                    <span className="dash-ops-jobs-plate">{job.plate_number}</span>

                    <span className="dash-ops-jobs-vehicle" title={vehicleLabel(job)}>{vehicleLabel(job)}</span>

                    <span className="dash-ops-jobs-type">{TYPE_LABELS[job.vehicle_type] ?? job.vehicle_type}</span>

                    <span className="dash-ops-jobs-dur">{fmtDur(job.duration_minutes)}</span>

                    <span className="dash-ops-jobs-paid">QAR {job.amount_paid.toLocaleString()}</span>

                    <span className="dash-ops-jobs-visits">{job.total_visits}×</span>

                    <ChevronRight size={14} className="dash-ops-jobs-chevron" />

                  </button>

                ))}

              </div>

            )}

          </div>

        )}



        {!isLoading && panel === 'services' && services.length === 0 && (

          <div className="dash-ops-empty">

            <Wrench size={24} strokeWidth={1.5} />

            <p>No completed services yet today.</p>

            <p className="dash-ops-empty-hint">Revenue and duration charts fill in as work orders are completed.</p>

          </div>

        )}



        {!isLoading && panel === 'services' && chartData.length > 0 && (

          <>

            <div className="dash-ops-chart-wrap">

              <ResponsiveContainer width="100%" height={Math.max(120, chartData.length * 36)}>

                <BarChart

                  data={chartData}

                  layout="vertical"

                  margin={{ top: 4, right: 12, left: 4, bottom: 4 }}

                  barCategoryGap="20%"

                >

                  <XAxis type="number" hide domain={[0, maxRev * 1.08]} />

                  <YAxis

                    type="category"

                    dataKey="shortName"

                    width={92}

                    tick={{ fill: 'var(--text-secondary)', fontSize: 10, fontWeight: 600 }}

                    axisLine={false}

                    tickLine={false}

                  />

                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(139,92,246,0.06)' }} />

                  <Bar dataKey="total_revenue" radius={[0, 6, 6, 0]} maxBarSize={22}>

                    {chartData.map((_, i) => (

                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />

                    ))}

                  </Bar>

                </BarChart>

              </ResponsiveContainer>

            </div>



            <div className="dash-ops-service-list">

              {services.map((svc, i) => {

                const revPct = Math.round((svc.total_revenue / maxRev) * 100);

                const onTime = svc.vs_estimate_pct <= 105;

                return (

                  <div key={svc.service_name} className="dash-ops-service-row">

                    <div className="dash-ops-service-name" title={svc.service_name}>

                      <span className="dash-ops-service-dot" style={{ background: BAR_COLORS[i % BAR_COLORS.length] }} />

                      {svc.service_name}

                    </div>

                    <div className="dash-ops-service-bar-wrap">

                      <div

                        className="dash-ops-service-bar"

                        style={{ width: `${revPct}%`, background: BAR_COLORS[i % BAR_COLORS.length] }}

                      />

                    </div>

                    <div className="dash-ops-service-rev">QAR {svc.total_revenue.toLocaleString()}</div>

                    <div className={`dash-ops-service-time${onTime ? '' : ' slow'}`}>

                      {fmtDur(svc.avg_minutes)}

                    </div>

                    <div className="dash-ops-service-count">{svc.count}×</div>

                  </div>

                );

              })}

            </div>



            {combinedRev > 0 && (

              <div className="dash-ops-footer">

                <TrendingUp size={13} />

                <span>

                  Top service: <strong>{services[0]?.service_name}</strong>

                  {' · '}

                  {Math.round((services[0].total_revenue / totalRev) * 100) || 0}% of today&apos;s revenue

                </span>

              </div>

            )}

          </>

        )}

      </div>



      {selectedJob && (

        <TodayOpsVehicleModal job={selectedJob} onClose={() => setSelectedJob(null)} />

      )}

    </>

  );

};


