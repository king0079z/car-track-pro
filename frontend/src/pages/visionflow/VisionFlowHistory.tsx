import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  History, ScanLine, RefreshCw, DownloadCloud, FileText,
  AlertCircle, ChevronDown, ChevronUp, Gauge, Activity,
  TrendingUp, Clock, CheckCircle2, XCircle, Loader2, Eye,
  Link2, Database,
} from 'lucide-react';
import { visionflowSyncApi } from '../../services/api';
import { fmtQatar } from '../../lib/qatarTime';

/* ─────────────────────────── Types ─────────────────────────────────────────── */

interface VehicleRow {
  track_id: number | null; plate: string;
  speed_kmh_max: number | null; speed_kmh_avg: number | null; speed_kmh_last: number | null;
  t_enter_sec: number | null; t_exit_sec: number | null;
  duration_sec: number | null; status: string;
}

interface HistoryItem {
  job_id: string; status: string; progress: number;
  input_name?: string; output_file?: string | null;
  processed_frames?: number; total_frames_est?: number;
  video_fps?: number; message?: string;
  vehicles?: VehicleRow[];
  analyze_options?: Record<string, unknown>;
  created_at?: string; updated_at?: string;
}

/* ─────────────────────────── Helpers ───────────────────────────────────────── */

const fmtDate = (s?: string) => {
  if (!s) return '—';
  try { return fmtQatar(s, 'dmyHm'); }
  catch { return s; }
};

const exportCsv = (rows: VehicleRow[], name: string) => {
  const cols: (keyof VehicleRow)[] = ['track_id', 'plate', 'speed_kmh_max', 'speed_kmh_avg', 'speed_kmh_last', 't_enter_sec', 't_exit_sec', 'duration_sec', 'status'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click(); URL.revokeObjectURL(a.href);
};

/* ─────────────────────────── Status badge ──────────────────────────────────── */

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const cfg: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
    done:    { label: 'Complete', color: '#10b981', bg: 'rgba(16,185,129,0.1)',  icon: <CheckCircle2 size={11} /> },
    error:   { label: 'Failed',   color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   icon: <XCircle size={11} /> },
    running: { label: 'Running',  color: '#3b82f6', bg: 'rgba(59,130,246,0.1)',  icon: <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> },
    queued:  { label: 'Queued',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  icon: <Clock size={11} /> },
  };
  const c = cfg[status] ?? { label: status, color: 'var(--text-muted)', bg: 'var(--bg-elevated)', icon: null };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 99,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.03em',
      background: c.bg, color: c.color,
      border: `1px solid ${c.color}30`,
    }}>
      {c.icon} {c.label}
    </span>
  );
};

/* ─────────────────────────── Summary card ──────────────────────────────────── */

const SummaryCard: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; color?: string }> = ({ icon, label, value, color = '#3b82f6' }) => (
  <div style={{
    padding: '14px 18px', borderRadius: 14,
    background: 'var(--bg-surface)', border: '1px solid var(--border-light)',
    display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 160px',
  }}>
    <div style={{
      width: 36, height: 36, borderRadius: 10, flexShrink: 0,
      background: `${color}15`, border: `1px solid ${color}22`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{icon}</div>
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>{value}</div>
    </div>
  </div>
);

/* ─────────────────────────── Main ──────────────────────────────────────────── */

export const VisionFlowHistory: React.FC = () => {
  const [rows, setRows] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncingJob, setSyncingJob] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/vf/api/history?limit=200');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = await r.json();
      setRows(Array.isArray(items) ? items : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, []);

  const syncAll = useCallback(async () => {
    setSyncingAll(true); setSyncMsg(null);
    try {
      const res = await visionflowSyncApi.syncHistory(100);
      setSyncMsg(`Synced ${res.data.plates_synced} plates from ${res.data.jobs_synced} jobs`);
    } catch { setSyncMsg('Sync failed — check backend'); }
    finally { setSyncingAll(false); setTimeout(() => setSyncMsg(null), 5000); }
  }, []);

  const syncOne = useCallback(async (jobId: string) => {
    setSyncingJob(jobId);
    try {
      const res = await visionflowSyncApi.syncJob(jobId);
      setSyncMsg(`Job synced: ${res.data.synced} plates → CarTrack`);
    } catch { setSyncMsg('Sync failed for this job'); }
    finally { setSyncingJob(null); setTimeout(() => setSyncMsg(null), 4000); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Stats */
  const totalRuns = rows.length;
  const doneRuns = rows.filter(r => r.status === 'done').length;
  const totalTracks = rows.reduce((s, r) => s + (r.vehicles?.length ?? 0), 0);
  const peakSpeed = Math.max(0, ...rows.flatMap(r => (r.vehicles ?? []).map(v => v.speed_kmh_max ?? 0)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ══ HERO ══ */}
      <div style={{
        position: 'relative',
        borderRadius: 20, overflow: 'hidden',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.07) 0%, rgba(139,92,246,0.05) 60%, rgba(16,185,129,0.04) 100%)',
        border: '1px solid var(--border-light)',
        padding: '24px 28px',
      }}>
        <div style={{ position: 'absolute', top: -50, right: 40, width: 220, height: 220, borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.1) 0%, transparent 70%)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 13, flexShrink: 0,
              background: 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(139,92,246,0.12))',
              border: '1px solid rgba(59,130,246,0.22)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 20px rgba(59,130,246,0.12)',
            }}>
              <History size={22} color="#3b82f6" />
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 5px', letterSpacing: '-0.3px' }}>
                Analysis history
              </h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
                Completed and active video analysis runs — plates, speeds, and vehicle timelines logged to SQLite.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', alignItems: 'center' }}>
            {syncMsg && (
              <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <Link2 size={11} /> {syncMsg}
              </span>
            )}
            <button className="btn btn-primary" onClick={syncAll} disabled={syncingAll}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px' }}>
              {syncingAll ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Database size={13} />}
              Sync all → CarTrack
            </button>
            <Link to="/visionflow" className="btn btn-secondary"
              style={{ textDecoration: 'none', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ScanLine size={14} /> Analyzer
            </Link>
            <button className="btn btn-secondary" onClick={load} disabled={loading}
              style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ══ SUMMARY CARDS ══ */}
      {totalRuns > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <SummaryCard icon={<Activity size={16} color="#3b82f6" />} label="Total runs" value={totalRuns} />
          <SummaryCard icon={<CheckCircle2 size={16} color="#10b981" />} label="Completed" value={doneRuns} color="#10b981" />
          <SummaryCard icon={<TrendingUp size={16} color="#8b5cf6" />} label="Total tracks" value={totalTracks} color="#8b5cf6" />
          {peakSpeed > 0 && <SummaryCard icon={<Gauge size={16} color="#f59e0b" />} label="Peak speed" value={`${peakSpeed} km/h`} color="#f59e0b" />}
        </div>
      )}

      {/* ══ ERROR ══ */}
      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: 12,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#ef4444',
        }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {/* ══ TABLE CARD ══ */}
      <div style={{ borderRadius: 16, border: '1px solid var(--border-light)', overflow: 'hidden', background: 'var(--bg-surface)' }}>

        {/* Table header */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Eye size={13} /> Runs
          </span>
          {!loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} record{rows.length !== 1 ? 's' : ''}</span>}
        </div>

        {loading ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading runs…
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '64px 32px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <History size={24} color="var(--text-muted)" strokeWidth={1.5} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>No runs yet</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>Upload a video from the analyzer to start detecting vehicles and reading plates.</p>
            <Link to="/visionflow" className="btn btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
              <ScanLine size={14} /> Go to Analyzer
            </Link>
          </div>
        ) : (
          <div>
            {rows.map((row, idx) => {
              const isOpen = expanded === row.job_id;
              const vCount = row.vehicles?.length ?? 0;
              const peak = Math.max(0, ...(row.vehicles ?? []).map(v => v.speed_kmh_max ?? 0));
              const isLast = idx === rows.length - 1;

              return (
                <div key={row.job_id}>
                  {/* Row */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto auto auto auto',
                      gap: 12,
                      alignItems: 'center',
                      padding: '14px 20px',
                      borderBottom: (isOpen || !isLast) ? '1px solid var(--border-light)' : 'none',
                      cursor: vCount > 0 ? 'pointer' : 'default',
                      transition: 'background 0.12s',
                    }}
                    onClick={() => vCount > 0 && setExpanded(isOpen ? null : row.job_id)}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}
                  >
                    {/* File info */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                        {row.input_name ?? `Job ${row.job_id.slice(0, 8)}…`}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{row.job_id.slice(0, 18)}…</span>
                        {row.created_at && (
                          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Clock size={9} /> {fmtDate(row.created_at)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Status */}
                    <StatusBadge status={row.status} />

                    {/* Progress */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 90 }}>
                      <div style={{ width: 60, height: 4, borderRadius: 99, background: 'var(--border)', overflow: 'hidden', flexShrink: 0 }}>
                        <div style={{
                          height: '100%', width: `${Math.min(100, row.progress ?? 0)}%`,
                          background: row.status === 'done' ? '#10b981' : row.status === 'error' ? '#ef4444' : '#3b82f6',
                          borderRadius: 99, transition: 'width 0.3s',
                        }} />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', width: 28 }}>
                        {Math.round(row.progress ?? 0)}%
                      </span>
                    </div>

                    {/* Stats */}
                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <TrendingUp size={11} color="#8b5cf6" />
                        <strong style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{vCount}</strong> tracks
                      </span>
                      {peak > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Gauge size={11} color="#f59e0b" />
                          <strong style={{ color: '#f59e0b', fontWeight: 700 }}>{peak}</strong> km/h
                        </span>
                      )}
                      {row.video_fps != null && row.video_fps > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
                          {(+row.video_fps).toFixed(1)} fps
                        </span>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {row.status === 'done' && vCount > 0 && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5, color: '#06b6d4', borderColor: 'rgba(6,182,212,0.3)' }}
                          disabled={syncingJob === row.job_id}
                          onClick={e => { e.stopPropagation(); syncOne(row.job_id); }}>
                          {syncingJob === row.job_id
                            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                            : <Link2 size={11} />}
                          Sync→DB
                        </button>
                      )}
                      {row.status === 'done' && row.output_file && (
                        <a href={`/vf/api/jobs/${encodeURIComponent(row.job_id)}/video`}
                          className="btn btn-secondary"
                          style={{ textDecoration: 'none', fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          download onClick={e => e.stopPropagation()}>
                          <DownloadCloud size={12} /> Video
                        </a>
                      )}
                      {vCount > 0 && (
                        <button className="btn btn-secondary"
                          style={{ fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          onClick={e => { e.stopPropagation(); exportCsv(row.vehicles!, `vf_${row.job_id.slice(0, 8)}.csv`); }}>
                          <FileText size={12} /> CSV
                        </button>
                      )}
                      {vCount > 0 && (
                        <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: '4px 6px' }}
                          onClick={e => { e.stopPropagation(); setExpanded(isOpen ? null : row.job_id); }}>
                          {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded vehicle registry */}
                  {isOpen && vCount > 0 && (
                    <div style={{
                      borderBottom: !isLast ? '1px solid var(--border-light)' : 'none',
                      background: 'var(--bg-elevated)',
                      padding: '0 20px 16px',
                    }}>
                      <div style={{ paddingTop: 14, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Eye size={11} /> Vehicle registry · {vCount} track{vCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div style={{
                        borderRadius: 10, overflow: 'hidden',
                        border: '1px solid var(--border-light)',
                        background: 'var(--bg-surface)',
                      }}>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ background: 'var(--bg-elevated)' }}>
                                {['#', 'Track', 'Plate', 'Peak km/h', 'Avg km/h', 'Last km/h', 'Enter', 'Exit', 'Dwell', 'State'].map(h => (
                                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {row.vehicles!.map((v, i) => (
                                <tr key={`${row.job_id}-${i}-${v.track_id ?? 'na'}`} style={{ borderBottom: i < vCount - 1 ? '1px solid var(--border-light)' : 'none' }}>
                                  <td style={{ padding: '9px 12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums' }}>{v.track_id ?? '—'}</td>
                                  <td style={{ padding: '9px 12px', fontWeight: 700, letterSpacing: '0.08em' }}>
                                    {v.plate && v.plate !== '—' ? (
                                      <Link
                                        to={`/vehicles?plate=${encodeURIComponent(v.plate)}`}
                                        style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 800, letterSpacing: '0.1em' }}
                                        title="Look up in vehicle DB"
                                      >{v.plate}</Link>
                                    ) : '—'}
                                  </td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums' }}>
                                    {v.speed_kmh_max != null ? <span style={{ color: '#f59e0b', fontWeight: 700 }}>{v.speed_kmh_max}</span> : '—'}
                                  </td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums' }}>
                                    {v.speed_kmh_avg != null ? <span style={{ color: '#3b82f6', fontWeight: 700 }}>{v.speed_kmh_avg}</span> : '—'}
                                  </td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{v.speed_kmh_last ?? '—'}</td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{v.t_enter_sec != null ? (+v.t_enter_sec).toFixed(2) + 's' : '—'}</td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{v.t_exit_sec != null ? (+v.t_exit_sec).toFixed(2) + 's' : '—'}</td>
                                  <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{v.duration_sec != null ? (+v.duration_sec).toFixed(2) + 's' : '—'}</td>
                                  <td style={{ padding: '9px 12px' }}>
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '2px 8px', borderRadius: 99,
                                      fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                                      background: v.status === 'active' ? 'rgba(59,130,246,0.1)' : 'rgba(16,185,129,0.1)',
                                      color: v.status === 'active' ? '#3b82f6' : '#10b981',
                                      border: `1px solid ${v.status === 'active' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)'}`,
                                    }}>
                                      {v.status === 'active' ? 'Live' : 'Done'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default VisionFlowHistory;
