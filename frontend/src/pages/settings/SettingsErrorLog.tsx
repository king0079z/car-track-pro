import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bug,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileJson,
  Radar,
  RefreshCw,
  Search,
  Server,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { errorsApi } from '../../services/api';
import { fmtQatar } from '../../lib/qatarTime';

export type ApplicationErrorRow = {
  id: number;
  severity: string;
  category: string;
  source: string;
  message: string;
  detail?: string | null;
  stack_trace?: string | null;
  context?: Record<string, unknown> | null;
  fingerprint?: string | null;
  occurrence_count: number;
  user_id?: number | null;
  job_id?: string | null;
  plate?: string | null;
  track_id?: number | null;
  resolved: boolean;
  last_seen_at?: string | null;
  created_at?: string | null;
};

type ErrorTab = 'overview' | 'plate' | 'application' | 'client';

const TABS: { id: ErrorTab; label: string; icon: typeof Bug; hint: string; categories?: string }[] = [
  { id: 'overview', label: 'Overview', icon: Bug, hint: 'Counts and severity breakdown' },
  { id: 'plate', label: 'Plate monitoring', icon: Camera, hint: 'VisionFlow, ANPR sync, live camera', categories: 'visionflow,anpr,camera' },
  { id: 'application', label: 'Application', icon: Server, hint: 'API, database, and system', categories: 'api,database,system' },
  { id: 'client', label: 'Client', icon: AlertTriangle, hint: 'Browser and frontend runtime', categories: 'client' },
];

const SEV_COLORS: Record<string, string> = {
  debug: '#94a3b8',
  info: '#38bdf8',
  warning: '#fbbf24',
  error: '#f87171',
  critical: '#ef4444',
};

const CAT_LABELS: Record<string, string> = {
  visionflow: 'VisionFlow',
  anpr: 'ANPR sync',
  camera: 'Live camera',
  api: 'API',
  client: 'Client',
  database: 'Database',
  system: 'System',
};

function SeverityBadge({ severity }: { severity: string }) {
  const s = severity.toLowerCase();
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 6,
        background: `${SEV_COLORS[s] || '#64748b'}22`,
        color: SEV_COLORS[s] || '#64748b',
        border: `1px solid ${SEV_COLORS[s] || '#64748b'}44`,
      }}
    >
      {s}
    </span>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 14,
        border: '1px solid var(--border-light)',
        background: 'var(--card-bg)',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone || 'var(--text-primary)', marginTop: 6, letterSpacing: '-0.03em' }}>
        {value}
      </div>
    </div>
  );
}

export const SettingsErrorLog: React.FC = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<ErrorTab>('overview');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [resolvedFilter, setResolvedFilter] = useState<'all' | 'open' | 'resolved'>('open');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  const activeTab = TABS.find(t => t.id === tab)!;

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['error-stats'],
    queryFn: () => errorsApi.stats(7).then(r => r.data),
    refetchInterval: 60_000,
  });

  const listParams = useMemo(() => {
    const p: Record<string, unknown> = { page, limit: 40, days: 30 };
    if (activeTab.categories) p.categories = activeTab.categories;
    if (search.trim()) p.search = search.trim();
    if (severity) p.severity = severity;
    if (resolvedFilter === 'open') p.resolved = false;
    if (resolvedFilter === 'resolved') p.resolved = true;
    return p;
  }, [activeTab.categories, page, search, severity, resolvedFilter]);

  const { data: rows = [], isLoading: listLoading, refetch } = useQuery({
    queryKey: ['error-log', listParams],
    queryFn: () => errorsApi.list(listParams).then(r => r.data as ApplicationErrorRow[]),
    enabled: tab !== 'overview',
    refetchInterval: 45_000,
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, resolved }: { id: number; resolved: boolean }) =>
      errorsApi.resolve(id, resolved).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['error-log'] });
      qc.invalidateQueries({ queryKey: ['error-stats'] });
      toast.success('Error updated');
    },
    onError: () => toast.error('Could not update error'),
  });

  const testMutation = useMutation({
    mutationFn: () => errorsApi.recordTest().then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['error-log'] });
      qc.invalidateQueries({ queryKey: ['error-stats'] });
      toast.success('Test error recorded');
    },
    onError: () => toast.error('Test recording failed'),
  });

  const exportFile = async (format: 'csv' | 'json') => {
    try {
      const res = await errorsApi.export({
        format,
        days: 30,
        categories: activeTab.categories,
        unresolvedOnly: resolvedFilter === 'open',
      });
      const blob = new Blob([res.data], { type: format === 'csv' ? 'text/csv' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cartrack-errors.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${format.toUpperCase()}`);
    } catch {
      toast.error('Export failed');
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    background: 'var(--input-bg)',
    border: '1px solid var(--border)',
    borderRadius: 11,
    color: 'var(--text-primary)',
    fontSize: 13.5,
    fontFamily: 'inherit',
    outline: 'none',
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setPage(1);
                setExpanded(null);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                borderRadius: 11,
                border: `1px solid ${active ? 'rgba(59,130,246,0.4)' : 'var(--border-light)'}`,
                background: active ? 'rgba(37,99,235,0.12)' : 'transparent',
                color: active ? 'var(--text-accent)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      <p style={{ margin: '0 0 18px', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.55, maxWidth: 720 }}>
        {activeTab.hint}. Server-side plate pipeline errors, ANPR sync failures, live camera recovery, API faults, and browser
        diagnostics are deduplicated by fingerprint and grouped here. Pair with{' '}
        <Link to="/audit" style={{ color: 'var(--text-accent)' }}>
          Audit
        </Link>{' '}
        for the full timeline.
      </p>

      {tab === 'overview' && (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
              marginBottom: 20,
            }}
          >
            <StatCard label="Total (7d)" value={statsLoading ? '…' : stats?.total ?? 0} />
            <StatCard label="Unresolved" value={statsLoading ? '…' : stats?.unresolved ?? 0} tone="#f87171" />
            <StatCard label="Last 24h" value={statsLoading ? '…' : stats?.last_24h ?? 0} />
            <StatCard label="Plate monitoring" value={statsLoading ? '…' : stats?.plate_monitoring ?? 0} tone="var(--text-accent)" />
          </div>

          {!statsLoading && stats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
              <div style={{ padding: 16, borderRadius: 14, border: '1px solid var(--border-light)', background: 'var(--card-bg)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)' }}>By category</div>
                {Object.entries(stats.by_category || {}).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <span>{CAT_LABELS[k] || k}</span>
                    <strong>{Number(v)}</strong>
                  </div>
                ))}
                {!Object.keys(stats.by_category || {}).length && (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No errors recorded yet.</div>
                )}
              </div>
              <div style={{ padding: 16, borderRadius: 14, border: '1px solid var(--border-light)', background: 'var(--card-bg)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)' }}>By severity</div>
                {Object.entries(stats.by_severity || {}).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <SeverityBadge severity={k} />
                    <strong>{Number(v)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setTab('plate')}>
              <Radar size={15} /> View plate errors
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              <Bug size={15} /> Record test error
            </button>
          </div>
        </div>
      )}

      {tab !== 'overview' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 180 }}>
              <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
              <input
                style={{ ...inputStyle, paddingLeft: 36 }}
                placeholder="Search message, source, detail…"
                value={search}
                onChange={e => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <select
              style={{ ...inputStyle, width: 'auto', minWidth: 130, cursor: 'pointer' }}
              value={severity}
              onChange={e => {
                setSeverity(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="error">Error</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            <select
              style={{ ...inputStyle, width: 'auto', minWidth: 130, cursor: 'pointer' }}
              value={resolvedFilter}
              onChange={e => {
                setResolvedFilter(e.target.value as 'all' | 'open' | 'resolved');
                setPage(1);
              }}
            >
              <option value="open">Open only</option>
              <option value="all">All</option>
              <option value="resolved">Resolved</option>
            </select>
            <button type="button" className="btn btn-secondary" onClick={() => refetch()} title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => exportFile('csv')}>
              <Download size={15} /> CSV
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => exportFile('json')}>
              <FileJson size={15} /> JSON
            </button>
          </div>

          {listLoading ? (
            <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading errors…</div>
          ) : rows.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                borderRadius: 14,
                border: '1px dashed var(--border)',
                color: 'var(--text-muted)',
              }}
            >
              <CheckCircle2 size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>No matching errors — plate pipeline is clean for this filter.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.map(row => {
                const open = expanded === row.id;
                return (
                  <div
                    key={row.id}
                    style={{
                      borderRadius: 14,
                      border: `1px solid ${row.resolved ? 'var(--border-light)' : 'rgba(248,113,113,0.25)'}`,
                      background: 'var(--card-bg)',
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : row.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '14px 16px',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'inherit',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                            <SeverityBadge severity={row.severity} />
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                              {CAT_LABELS[row.category] || row.category}
                            </span>
                            {row.occurrence_count > 1 && (
                              <span style={{ fontSize: 11, color: 'var(--text-warning)', fontWeight: 700 }}>
                                ×{row.occurrence_count}
                              </span>
                            )}
                            {row.resolved && (
                              <span style={{ fontSize: 11, color: '#34d399', fontWeight: 700 }}>Resolved</span>
                            )}
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                            {row.message}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                            {row.source}
                            {row.job_id && ` · job ${row.job_id.slice(0, 8)}…`}
                            {row.plate && ` · ${row.plate}`}
                            {row.last_seen_at && ` · ${fmtQatar(row.last_seen_at, 'dmyHm')}`}
                          </div>
                        </div>
                        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </div>
                    </button>

                    {open && (
                      <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-light)' }}>
                        {row.detail && (
                          <pre
                            style={{
                              margin: '12px 0',
                              padding: 12,
                              borderRadius: 10,
                              background: 'var(--input-bg)',
                              fontSize: 12,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 200,
                              overflow: 'auto',
                            }}
                          >
                            {row.detail}
                          </pre>
                        )}
                        {row.stack_trace && (
                          <pre
                            style={{
                              margin: '0 0 12px',
                              padding: 12,
                              borderRadius: 10,
                              background: 'rgba(0,0,0,0.25)',
                              fontSize: 11,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 240,
                              overflow: 'auto',
                              color: '#fca5a5',
                            }}
                          >
                            {row.stack_trace}
                          </pre>
                        )}
                        {row.context && Object.keys(row.context).length > 0 && (
                          <pre
                            style={{
                              margin: '0 0 12px',
                              padding: 12,
                              borderRadius: 10,
                              background: 'var(--input-bg)',
                              fontSize: 11,
                              whiteSpace: 'pre-wrap',
                              maxHeight: 160,
                              overflow: 'auto',
                            }}
                          >
                            {JSON.stringify(row.context, null, 2)}
                          </pre>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => resolveMutation.mutate({ id: row.id, resolved: !row.resolved })}
                          >
                            {row.resolved ? (
                              <>
                                <XCircle size={14} /> Reopen
                              </>
                            ) : (
                              <>
                                <CheckCircle2 size={14} /> Mark resolved
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {rows.length >= 40 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
              <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                Previous
              </button>
              <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--text-muted)' }}>Page {page}</span>
              <button type="button" className="btn btn-secondary" onClick={() => setPage(p => p + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
