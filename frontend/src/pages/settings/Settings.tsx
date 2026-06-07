import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings as SettingsIcon,
  Save,
  Clock,
  Building2,
  ChevronRight,
  Zap,
  X,
  Users,
  Download,
  RotateCcw,
  Upload,
  Activity,
  Sparkles,
  DollarSign,
  Eye,
  Lock,
  AlertTriangle,
  Server,
  Radar,
  Bell,
  Bug,
  Cloud,
  Video,
} from 'lucide-react';
import { api, settingsApi } from '../../services/api';
import { SettingsErrorLog } from './SettingsErrorLog';
import { DahuaHeroA1Panel } from './DahuaHeroA1Panel';
import { DahuaCloudConnect } from './DahuaCloudConnect';
import { CamerasManager } from './CamerasManager';
import { qatarYmd, syncClientTimeFromPublicSettings } from '../../lib/qatarTime';
import toast from 'react-hot-toast';

type SettingsSection = {
  id: string;
  label: string;
  icon: typeof Building2;
  hint: string;
};

const SECTIONS: SettingsSection[] = [
  { id: 'organization', label: 'Organization', icon: Building2, hint: 'Identity, locale, and tax profile' },
  { id: 'operations', label: 'Operations', icon: Clock, hint: 'Bays, hours, dwell policies' },
  { id: 'revenue', label: 'Revenue', icon: DollarSign, hint: 'Tax display and staff visibility' },
  { id: 'notifications', label: 'Notifications', icon: Bell, hint: 'Alerts and reporting recipients' },
  { id: 'cameras', label: 'Cameras', icon: Video, hint: 'Add and manage many cameras (Dahua cloud + RTSP/NVR)' },
  { id: 'camera-cloud', label: 'Camera cloud', icon: Cloud, hint: 'Connect DH-H3A via Easy4IP and open live feed' },
  { id: 'integrations', label: 'AI & vision', icon: Radar, hint: 'ANPR, cameras, and automation defaults' },
  { id: 'privacy', label: 'Privacy & audit', icon: Eye, hint: 'Logging posture and diagnostics' },
  { id: 'errors', label: 'Error log', icon: Bug, hint: 'Plate monitoring and application diagnostics' },
  { id: 'security', label: 'Security', icon: Lock, hint: 'Sessions, lockout, network posture' },
  { id: 'advanced', label: 'Advanced', icon: Sparkles, hint: 'Density, import/export, reset' },
];

const TIMEZONES = [
  'Asia/Qatar',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Africa/Cairo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function pickTimezones(): string[] {
  try {
    const iv = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof iv.supportedValuesOf === 'function') {
      const all = iv.supportedValuesOf('timeZone');
      const common = TIMEZONES.filter(tz => all.includes(tz));
      const extra = all.filter(t => !common.includes(t)).slice(0, 40);
      return [...common, ...extra].sort();
    }
  } catch {
    /* ignore */
  }
  return TIMEZONES;
}

export const Settings: React.FC = () => {
  const qc = useQueryClient();
  const [active, setActive] = useState('organization');
  const [dirty, setDirty] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const tzOptions = useMemo(() => pickTimezones(), []);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then(r => r.data as Record<string, unknown>),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get('/api/health').then(r => r.data as Record<string, unknown>),
    refetchInterval: 90_000,
    staleTime: 30_000,
  });

  const [form, setForm] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  useEffect(() => {
    const sec = new URLSearchParams(window.location.search).get('section');
    if (sec && SECTIONS.some(s => s.id === sec)) setActive(sec);
  }, []);

  useEffect(() => {
    const tz = settings?.timezone;
    if (typeof tz === 'string' && tz.trim()) syncClientTimeFromPublicSettings({ timezone: tz });
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => settingsApi.update(data).then(r => r.data as Record<string, unknown>),
    onSuccess: data => {
      toast.success('Settings saved');
      setDirty(false);
      setForm(data);
      qc.invalidateQueries({ queryKey: ['settings'] });
      settingsApi
        .public()
        .then(res => {
          window.__CARTRACK_REPORT_ERRORS__ = res.data.client_error_auto_capture !== false;
          syncClientTimeFromPublicSettings(res.data);
        })
        .catch(() => {
          window.__CARTRACK_REPORT_ERRORS__ = true;
        });
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } } };
      toast.error(err?.response?.data?.detail || 'Save failed');
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => settingsApi.reset().then(r => r.data as Record<string, unknown>),
    onSuccess: data => {
      toast.success('Restored factory defaults');
      setDirty(false);
      setForm(data);
      setResetOpen(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
      settingsApi
        .public()
        .then(res => {
          window.__CARTRACK_REPORT_ERRORS__ = res.data.client_error_auto_capture !== false;
          syncClientTimeFromPublicSettings(res.data);
        })
        .catch(() => {});
    },
    onError: () => toast.error('Could not reset settings'),
  });

  const setField = useCallback((key: string, val: unknown) => {
    setForm(f => ({ ...f, [key]: val }));
    setDirty(true);
  }, []);

  const inputStyle: React.CSSProperties = useMemo(
    () => ({
      width: '100%',
      padding: '10px 14px',
      background: 'var(--input-bg)',
      border: '1px solid var(--border)',
      borderRadius: 11,
      color: 'var(--text-primary)',
      fontSize: 13.5,
      fontFamily: 'inherit',
      outline: 'none',
    }),
    [],
  );

  const SectionHeader: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, maxWidth: 640 }}>
          {subtitle}
        </p>
      )}
    </div>
  );

  const ToggleRow: React.FC<{ label: string; desc?: string; k: string }> = ({ label, desc, k }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '16px 0',
        borderBottom: '1px solid var(--border-light)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>{desc}</div>}
      </div>
      <button
        type="button"
        aria-pressed={Boolean(form[k])}
        onClick={() => setField(k, !form[k])}
        style={{
          width: 48,
          height: 26,
          borderRadius: 99,
          border: 'none',
          cursor: 'pointer',
          background: form[k] ? 'linear-gradient(135deg,#2563eb,#7c3aed)' : 'var(--border)',
          transition: 'background 0.2s',
          position: 'relative',
          flexShrink: 0,
          boxShadow: form[k] ? '0 4px 14px rgba(37,99,235,0.35)' : 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: form[k] ? 26 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'white',
            transition: 'left 0.2s',
            boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
          }}
        />
      </button>
    </div>
  );

  const InputRow: React.FC<{
    label: string;
    desc?: string;
    k: string;
    type?: string;
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
  }> = ({ label, desc, k, type = 'text', placeholder, min, max, step }) => (
    <div style={{ marginBottom: 18 }}>
      <label className="label" style={{ fontWeight: 700, fontSize: 12 }}>
        {label}
      </label>
      {desc && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px', lineHeight: 1.45 }}>{desc}</p>}
      <input
        type={type}
        style={inputStyle}
        value={form[k] === undefined || form[k] === null ? '' : String(form[k])}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const v = e.target.value;
          if (type === 'number') {
            if (v === '') setField(k, '');
            else setField(k, Number(v));
          } else setField(k, v);
        }}
      />
    </div>
  );

  const SelectRow: React.FC<{ label: string; desc?: string; k: string; options: { v: string; l: string }[] }> = ({
    label,
    desc,
    k,
    options,
  }) => (
    <div style={{ marginBottom: 18 }}>
      <label className="label" style={{ fontWeight: 700, fontSize: 12 }}>
        {label}
      </label>
      {desc && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>{desc}</p>}
      <select style={{ ...inputStyle, cursor: 'pointer' }} value={String(form[k] ?? '')} onChange={e => setField(k, e.target.value)}>
        {options.map(o => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </div>
  );

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(form, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cartrack-settings-${qatarYmd()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Settings exported');
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid');
        setForm(prev => ({ ...prev, ...parsed }));
        setDirty(true);
        toast.success('Imported — review changes, then save');
      } catch {
        toast.error('Invalid settings JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const activeMeta = SECTIONS.find(s => s.id === active);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 320 }}>
        <div className="spinner" style={{ width: 36, height: 36 }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ maxWidth: 1180, margin: '0 auto' }}>
      <style>{`
        @keyframes settings-shimmer {
          0% { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        .settings-admin-grid {
          display: grid;
          grid-template-columns: minmax(200px, 240px) 1fr;
          gap: 22px;
          align-items: start;
        }
        @media (max-width: 960px) {
          .settings-admin-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* Hero */}
      <div
        style={{
          position: 'relative',
          borderRadius: 20,
          overflow: 'hidden',
          marginBottom: 22,
          border: '1px solid var(--border-light)',
          background: 'linear-gradient(135deg, rgba(37,99,235,0.12) 0%, rgba(124,58,237,0.08) 45%, rgba(15,118,110,0.06) 100%)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.04) 50%, transparent 65%)',
            backgroundSize: '200% 100%',
            animation: 'settings-shimmer 12s ease infinite',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', padding: '24px 26px 22px', display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', minWidth: 0 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                background: 'linear-gradient(135deg, rgba(37,99,235,0.45), rgba(124,58,237,0.3))',
                border: '1px solid rgba(147,197,253,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <SettingsIcon size={26} color="#e0e7ff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <h1 className="page-title" style={{ margin: 0, fontSize: 26, letterSpacing: '-0.03em' }}>
                  Control center
                </h1>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    padding: '5px 11px',
                    borderRadius: 99,
                    background: 'rgba(248,113,113,0.12)',
                    color: 'var(--text-danger)',
                    border: '1px solid rgba(248,113,113,0.28)',
                  }}
                >
                  Admin only
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.65, maxWidth: 560 }}>
                Tune how CarTrack behaves for your shop — hours, revenue rules, AI defaults, security posture, and audit-friendly diagnostics.
                Changes apply immediately after save for connected clients (some flags refresh on navigation).
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                <Link
                  to="/users"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    borderRadius: 10,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-light)',
                    color: 'var(--text-secondary)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  <Users size={14} /> Users
                </Link>
                <Link
                  to="/audit"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    borderRadius: 10,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-light)',
                    color: 'var(--text-secondary)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  <Activity size={14} /> Audit & errors
                </Link>
                <Link
                  to="/services"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    borderRadius: 10,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-light)',
                    color: 'var(--text-secondary)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  <Sparkles size={14} /> Services catalog
                </Link>
                <Link
                  to="/visionflow"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    borderRadius: 10,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-light)',
                    color: 'var(--text-secondary)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  <Radar size={14} /> ANPR workspace
                </Link>
              </div>
            </div>
          </div>

          {/* Server pulse */}
          <div
            className="card"
            style={{
              padding: '14px 18px',
              borderRadius: 14,
              border: '1px solid var(--border-light)',
              minWidth: 220,
              background: 'var(--bg-surface)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Server size={16} color="#34d399" />
              <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                API pulse
              </span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-success)', marginBottom: 6 }}>
              {String(health?.status ?? '…')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 }}>
              <div>{String(health?.app ?? 'CarTrack Pro')}</div>
              <div>v{String(health?.version ?? '—')}</div>
              <div style={{ marginTop: 6 }}>
                VisionFlow model: {health?.visionflow_model_ready ? 'ready' : 'missing'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-admin-grid">
        {/* Sidebar */}
        <aside className="card" style={{ padding: 10, position: 'sticky', top: 12, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: 'var(--text-muted)', textTransform: 'uppercase', padding: '4px 10px 10px' }}>
            Sections
          </div>
          {SECTIONS.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              style={{
                width: '100%',
                padding: '11px 12px',
                borderRadius: 11,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                border: `1px solid ${active === id ? 'rgba(59,130,246,0.35)' : 'transparent'}`,
                cursor: 'pointer',
                background: active === id ? 'rgba(37,99,235,0.12)' : 'transparent',
                color: active === id ? 'var(--text-accent)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: 600,
                textAlign: 'left',
                transition: 'all 0.15s',
                marginBottom: 4,
              }}
            >
              <Icon size={16} style={{ marginTop: 2, flexShrink: 0, opacity: active === id ? 1 : 0.75 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}>{label}</span>
                <span style={{ display: 'block', fontSize: 10.5, fontWeight: 500, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.35 }}>
                  {hint}
                </span>
              </span>
              {active === id && <ChevronRight size={14} style={{ flexShrink: 0, marginTop: 3 }} />}
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 10, paddingTop: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: 'var(--text-muted)', textTransform: 'uppercase', padding: '0 10px 8px' }}>
              Tip
            </div>
            <p style={{ margin: 0, padding: '0 10px', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Pair restrictive IP ranges with strong session timeouts when exposing CarTrack beyond your LAN.
            </p>
          </div>
        </aside>

        {/* Panel */}
        <div className="card card-p animate-scale-in" style={{ borderRadius: 18, padding: '26px 28px 24px' }} key={active}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              {activeMeta && (
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 13,
                    background: 'linear-gradient(145deg, rgba(99,102,241,0.2), rgba(45,212,191,0.12))',
                    border: '1px solid var(--border-light)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <activeMeta.icon size={20} color="#a5b4fc" />
                </div>
              )}
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  {activeMeta?.label}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>{activeMeta?.hint}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {dirty && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setForm(settings || {}); setDirty(false); }}>
                  <X size={14} /> Discard
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate(form)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                {saveMutation.isPending ? (
                  <>
                    <div className="spinner" style={{ width: 14, height: 14 }} /> Saving…
                  </>
                ) : (
                  <>
                    <Save size={15} /> Save changes
                  </>
                )}
              </button>
            </div>
          </div>

          {active === 'organization' && (
            <>
              <SectionHeader
                title="Organization profile"
                subtitle="Shown on exports and internal dashboards. Login screen reads business name and optional maintenance notice from public settings."
              />
              <InputRow label="Business name" k="business_name" placeholder="CarTrack Pro" />
              <InputRow label="Business email" k="business_email" type="email" placeholder="ops@example.com" />
              <InputRow label="Phone" k="phone" type="tel" placeholder="+974 …" />
              <InputRow label="Address" k="address" placeholder="Street, city, country" />
              <InputRow label="Tax / registration ID" k="tax_id" placeholder="Optional" />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
                <InputRow label="Currency code" k="currency" placeholder="QAR" />
                <SelectRow
                  label="Default locale"
                  k="default_locale"
                  desc="Used for future localized formats"
                  options={[
                    { v: 'en', l: 'English' },
                    { v: 'ar', l: 'Arabic (metadata)' },
                  ]}
                />
              </div>
              <SelectRow
                label="Timezone"
                k="timezone"
                desc="Used for scheduling displays and reports"
                options={tzOptions.map(tz => ({ v: tz, l: tz }))}
              />
              <InputRow
                label="Maintenance notice (login banner)"
                k="maintenance_message"
                desc="Short message shown on the sign-in screen — leave empty to hide."
                placeholder="Tonight 02:00–03:00 maintenance window"
              />
            </>
          )}

          {active === 'operations' && (
            <>
              <SectionHeader
                title="Shop operations"
                subtitle="Capacity, opening hours, and guardrails for visit lifecycle."
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                <InputRow label="Total service bays" k="total_bays" type="number" min={1} max={500} placeholder="5" />
                <InputRow label="Max service duration (hours)" k="max_service_hours" type="number" min={1} max={72} placeholder="8" />
                <InputRow
                  label="Overstay threshold (minutes)"
                  k="overstay_threshold_minutes"
                  type="number"
                  desc="Highlight visits exceeding this dwell time"
                  min={0}
                  placeholder="120"
                />
                <InputRow
                  label="Checkout grace (minutes)"
                  k="grace_period_minutes"
                  type="number"
                  desc="Optional policy hint for staff handoff windows"
                  min={0}
                  placeholder="15"
                />
                <InputRow
                  label="Idle warning (minutes)"
                  k="idle_warning_minutes"
                  type="number"
                  desc="Suggested threshold for stale in-progress visits"
                  min={5}
                  placeholder="45"
                />
                <InputRow
                  label="Max concurrent active visits"
                  k="max_concurrent_active_visits"
                  type="number"
                  desc="0 = unlimited — use for capacity governance"
                  min={0}
                  placeholder="0"
                />
                <InputRow
                  label="Vehicle re-entry waiting period (minutes)"
                  k="plate_resume_wait_minutes"
                  type="number"
                  desc="When a tracked car leaves the camera (e.g. moves to another bay) its record is Paused for this long. If the same plate returns within the window its in-shop time resumes; otherwise the record becomes Done. 0 = finalize immediately on exit."
                  min={0}
                  placeholder="120"
                />
              </div>
              <SelectRow
                label="Week starts on"
                k="week_starts_on"
                options={[
                  { v: 'sunday', l: 'Sunday' },
                  { v: 'monday', l: 'Monday' },
                ]}
              />
              <div style={{ marginBottom: 18 }}>
                <label className="label" style={{ fontWeight: 700, fontSize: 12 }}>
                  Opening hours
                </label>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 10px' }}>Displayed reference — integrate with your roster as needed.</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <input
                    type="time"
                    style={inputStyle}
                    value={String(form.opening_time ?? '07:00')}
                    onChange={e => setField('opening_time', e.target.value)}
                  />
                  <input
                    type="time"
                    style={inputStyle}
                    value={String(form.closing_time ?? '22:00')}
                    onChange={e => setField('closing_time', e.target.value)}
                  />
                </div>
              </div>
              <ToggleRow label="Require customer signature" k="require_signature" desc="Encourage capture during checkout flows" />
              <ToggleRow label="Auto-checkout at closing time" k="auto_checkout" desc="Policy hint — enforce operationally if required" />
            </>
          )}

          {active === 'revenue' && (
            <>
              <SectionHeader title="Revenue & pricing display" subtitle="Tax transparency and what operators see in the UI." />
              <InputRow
                label="Tax rate (%)"
                k="tax_rate_percent"
                type="number"
                step={0.01}
                min={0}
                max={100}
                placeholder="0"
                desc="For receipts and analytics labels — does not replace accounting rules."
              />
              <ToggleRow label="Prices include tax in UI copy" k="prices_include_tax" desc="When on, treat catalogue amounts as tax-inclusive in staff-facing labels" />
              <ToggleRow label="Show revenue tiles to all staff" k="show_revenue_to_staff" desc="When off, reserve sensitive KPIs for managers via navigation habits" />
            </>
          )}

          {active === 'notifications' && (
            <>
              <SectionHeader title="Notifications" subtitle="Routing signals for operational awareness." />
              <ToggleRow label="Email notifications" k="email_notifications" />
              <ToggleRow label="SMS notifications (planned)" k="sms_notifications" desc="Stored preference — wire to your SMS gateway when ready" />
              <ToggleRow label="Overstay alerts" k="overstay_alerts" desc="When dwell crosses the configured threshold" />
              <ToggleRow label="New entry alerts" k="new_entry_alerts" />
              <ToggleRow label="Daily digest email" k="daily_report" />
              <InputRow label="Primary notification email" k="notification_email" type="email" placeholder="ops@example.com" />
            </>
          )}

          {active === 'cameras' && (
            <>
              <SectionHeader
                title="Cameras"
                subtitle="Add and manage many cameras — Dahua cloud (Easy4IP) and generic RTSP/NVR. Each one auto-joins the live ANPR camera wall."
              />
              <CamerasManager />
            </>
          )}

          {active === 'camera-cloud' && (
            <>
              <SectionHeader
                title="Camera cloud connect"
                subtitle="Guided setup — connect your DH-H3A, verify video, then open the live ANPR feed automatically."
              />
              <DahuaCloudConnect />
            </>
          )}

          {active === 'integrations' && (
            <>
              <SectionHeader
                title="AI, cameras, and VisionFlow"
                subtitle="Feature switches visible to admins — heavy inference still respects server resources."
              />
              <ToggleRow label="AI license-plate assistance" k="ai_lpr_enabled" desc="Signals intent to use AI-assisted reads where deployed" />
              <ToggleRow label="Vehicle type / model hints" k="vehicle_detection_enabled" />
              <ToggleRow label="Verbose debug logging (clients)" k="debug_mode" desc="Maps to richer diagnostics — avoid in production" />
              <ToggleRow label="Default deep VisionFlow analysis" k="visionflow_deep_analysis_default" desc="Prefer higher-quality uploads when staff queue jobs" />
              <ToggleRow label="Suggest visit creation from ANPR rows" k="anpr_auto_suggest_visit" desc="Workflow hint when linking plates to visits" />
              <InputRow label="AI confidence floor" k="ai_confidence" type="number" step={0.05} min={0.05} max={0.99} placeholder="0.7" />
              <InputRow label="Camera poll interval (seconds)" k="camera_poll_interval" type="number" min={5} max={3600} placeholder="30" />
              <div style={{ marginTop: 8 }}>
                <DahuaHeroA1Panel />
              </div>
            </>
          )}

          {active === 'privacy' && (
            <>
              <SectionHeader
                title="Privacy, audit, and diagnostics"
                subtitle="Balance forensic visibility with noise — pair with Settings › Error log and Audit › System error logs."
              />
              <ToggleRow label="Verbose audit logging" k="audit_all" desc="Encourage capturing granular actions in the audit timeline" />
              <ToggleRow
                label="Automatic client error capture"
                k="client_error_auto_capture"
                desc="When off, browsers stop streaming JS/API diagnostics (still allows manual incident reports)"
              />
              <ToggleRow label="Require 2FA for privileged admins" k="admin_2fa" desc="Policy flag — enforce via your IdP or future auth upgrade" />
              <ToggleRow label="Compact UI density" k="compact_ui_density" desc="Tighter tables for power users on laptops" />
            </>
          )}

          {active === 'errors' && (
            <>
              <SectionHeader
                title="Application error log"
                subtitle="Every plate pipeline failure, ANPR sync error, live camera recovery, API fault, and browser diagnostic — deduplicated and searchable."
              />
              <SettingsErrorLog />
            </>
          )}

          {active === 'security' && (
            <>
              <SectionHeader title="Security posture" subtitle="Session hygiene and optional network clamp." />
              <InputRow label="Session timeout (minutes)" k="session_timeout_minutes" type="number" min={15} placeholder="480" desc="Policy reference — JWT expiry still governed server-side" />
              <InputRow label="Max login attempts (policy)" k="max_login_attempts" type="number" min={3} max={50} placeholder="5" />
              <div style={{ marginTop: 8 }}>
                <label className="label" style={{ fontWeight: 700, fontSize: 12 }}>
                  Allowed IP ranges / CIDR
                </label>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 10px', lineHeight: 1.45 }}>
                  Document enforcement expectations — actual filtering belongs on your reverse proxy or firewall.
                </p>
                <textarea
                  style={{ ...inputStyle, minHeight: 96, resize: 'vertical' }}
                  placeholder={'203.0.113.0/24\n198.51.100.50'}
                  value={String(form.allowed_ips ?? '')}
                  onChange={e => setField('allowed_ips', e.target.value)}
                />
              </div>
            </>
          )}

          {active === 'advanced' && (
            <>
              <SectionHeader
                title="Advanced tooling"
                subtitle="Portable configuration — ideal for staging clones and DR rehearsals."
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
                <button type="button" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={exportJson}>
                  <Download size={15} /> Export JSON
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                  onClick={() => importRef.current?.click()}
                >
                  <Upload size={15} /> Import JSON
                </button>
                <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportFile} />
              </div>

              <div
                style={{
                  padding: 18,
                  borderRadius: 14,
                  border: '1px solid rgba(248,113,113,0.35)',
                  background: 'linear-gradient(165deg, rgba(248,113,113,0.06), transparent)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <AlertTriangle size={18} color="#f87171" />
                  <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>Danger zone</span>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.55 }}>
                  Reset merges the on-disk profile back to CarTrack defaults (your database is untouched). Export first if you need a rollback copy.
                </p>
                <button type="button" className="btn btn-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => setResetOpen(true)}>
                  <RotateCcw size={15} /> Reset all settings
                </button>
              </div>
            </>
          )}

          {dirty && (
            <div
              style={{
                marginTop: 26,
                padding: '14px 18px',
                borderRadius: 13,
                background: 'rgba(37,99,235,0.08)',
                border: '1px solid rgba(59,130,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-accent)', fontWeight: 600 }}>
                <Zap size={15} /> Unsaved changes — remember to save
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setForm(settings || {}); setDirty(false); }}>
                  <X size={13} /> Discard
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(form)}>
                  {saveMutation.isPending ? 'Saving…' : (
                    <>
                      <Save size={13} /> Save
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {resetOpen && (
        <div className="modal-backdrop" onClick={() => !resetMutation.isPending && setResetOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>Reset settings?</h2>
              <button type="button" className="btn btn-ghost btn-icon" disabled={resetMutation.isPending} onClick={() => setResetOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 0 }}>
                This restores factory defaults in <code style={{ fontSize: 12 }}>settings.json</code>. Database users, visits, and audit history are not deleted.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" disabled={resetMutation.isPending} onClick={() => setResetOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={resetMutation.isPending} onClick={() => resetMutation.mutate()}>
                {resetMutation.isPending ? 'Resetting…' : 'Reset now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
