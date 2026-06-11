import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Upload, History, DownloadCloud, FileText, X,
  Webcam,
  CheckCircle2, AlertCircle, Loader2, Zap, ScanLine,
  ChevronDown, ChevronUp, Eye, Gauge, Activity,
  Video, Clock, TrendingUp, Link2, Plus, Search,
  Car, ArrowRight, User, Phone, Grid2X2,
} from 'lucide-react';
import { anprApi, camerasApi, visionflowApi, visionflowSyncApi } from '../../services/api';
import { DahuaHeroA1Panel } from '../settings/DahuaHeroA1Panel';
import {
  PlateConfidenceCell,
  PlateTrackStatusBadge,
  type VisionFlowVehicleRow,
} from './VisionFlowPlateQuality';

/* ─────────────────────────── Types ─────────────────────────────────────────── */

interface PipelineOpts {
  conf: number; iou: number; stride: number; width: number;
  meter_per_pixel: number; max_speed: number; speed_smooth: number;
  fps: number; ocr_interval: number; min_ocr_conf: number;
  track_imgsz: number; preview_jpeg_quality: number;
  prefer_fast_encoder: boolean;
}

type VehicleRow = VisionFlowVehicleRow;

interface LiveHealth {
  stream_connected?: boolean;
  reconnect_count?: number;
  uptime_sec?: number;
  processed_frames?: number;
  idle?: boolean;
  stream_tier?: 'sd' | 'hd' | null;
  segments?: string[];
  message?: string;
  last_frame_at?: string | null;
}

interface JobState {
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number | null;
  message: string;
  processed_frames: number; total_frames_est: number;
  output_file: string | null; input_name: string;
  vehicles: VehicleRow[]; video_fps?: number;
  analyze_options?: { probe_video_fps?: number };
  is_live?: boolean;
  always_on?: boolean;
  session_id?: string;
  live_health?: LiveHealth;
}

interface SyncedDetection {
  id: number; plate: string; speed_kmh: number | null;
  vehicle_id: number | null;
  vehicle: { id: number; plate_number: string; make: string | null; model: string | null; owner_name: string | null; owner_phone: string | null; total_visits: number } | null;
  visit_id: number | null;
  detected_at: string;
  t_enter_sec?: number | null;
  t_exit_sec?: number | null;
  duration_sec?: number | null;
}

interface PlateAction {
  plate: string;
  jobId?: string;
  panelLabel?: string;
  detectionId: number | null;
  vehicle: SyncedDetection['vehicle'] | null;
  linkedVisitId: number | null;
  state: 'idle' | 'loading' | 'found' | 'not_found' | 'creating' | 'created' | 'error';
  error?: string;
}

/* ─────────────────────────── Presets ───────────────────────────────────────── */

const PRESETS: Record<string, PipelineOpts> = {
  fast: { conf: 0.22, iou: 0.58, stride: 4, width: 960, meter_per_pixel: 0.05, max_speed: 130, speed_smooth: 0.44, fps: 0, ocr_interval: 4, min_ocr_conf: 0.34, track_imgsz: 896, preview_jpeg_quality: 72, prefer_fast_encoder: false },
  balanced: { conf: 0.16, iou: 0.55, stride: 2, width: 1120, meter_per_pixel: 0.05, max_speed: 130, speed_smooth: 0.38, fps: 0, ocr_interval: 2, min_ocr_conf: 0.28, track_imgsz: 1088, preview_jpeg_quality: 78, prefer_fast_encoder: false },
  accurate: { conf: 0.11, iou: 0.48, stride: 1, width: 1280, meter_per_pixel: 0.05, max_speed: 130, speed_smooth: 0.32, fps: 0, ocr_interval: 1, min_ocr_conf: 0.22, track_imgsz: 1280, preview_jpeg_quality: 84, prefer_fast_encoder: false },
};

/* ─────────────────────────── Helpers ───────────────────────────────────────── */

const fmtBytes = (n: number) => { if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return n.toFixed(1) + ' ' + u[i]; };
const fmtClock = (sec: number | null | undefined) => { if (sec == null || isNaN(+sec)) return '—'; const t = Math.max(0, +sec); return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
const exportCsv = (rows: VehicleRow[], name = 'visionflow_registry.csv') => {
  const cols: (keyof VehicleRow)[] = ['track_id', 'plate', 'ocr_confidence', 'ocr_vote_count', 'segment_count', 'speed_kmh_max', 'speed_kmh_avg', 'speed_kmh_last', 't_enter_sec', 't_exit_sec', 'duration_sec', 'status', 'resume_eligible', 'first_frame', 'last_frame'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); a.click(); URL.revokeObjectURL(a.href);
};

/* ─────────────────────────── Sub-components ────────────────────────────────── */

const Tag: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = '#3b82f6' }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 99, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', background: `${color}18`, color, border: `1px solid ${color}30` }}>{children}</span>
);

const SlimField: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
    {children}
    {hint && <span style={{ fontSize: 9.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>{hint}</span>}
  </div>
);

const NumIn: React.FC<{ value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }> = ({ value, onChange, min, max, step }) => (
  <input type="number" value={value} min={min} max={max} step={step} onChange={e => onChange(parseFloat(e.target.value) || 0)}
    style={{ width: '100%', padding: '7px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
    onFocus={e => (e.target.style.borderColor = 'var(--blue)')}
    onBlur={e => (e.target.style.borderColor = 'var(--border-light)')}
  />
);

const StatPill: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; color?: string }> = ({ icon, label, value, color = 'var(--blue)' }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', flex: 1, minWidth: 0 }}>
    <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: `${color}15`, border: `1px solid ${color}25`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  </div>
);

/* ─────────────────────────── Plate Action Card ─────────────────────────────── */

const PlateActionCard: React.FC<{
  pa: PlateAction;
  onCreateVisit?: (pa: PlateAction, extra: { owner_name?: string; owner_phone?: string; assigned_bay?: number }) => void;
}> = ({ pa }) => {
  const navigate = useNavigate();
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [bay, setBay] = useState('');

  const openWorkOrderWizard = (extra?: { owner_name?: string; owner_phone?: string; assigned_bay?: number }) => {
    const params = new URLSearchParams();
    params.set('plate', pa.plate);
    if (pa.detectionId) params.set('detection_id', String(pa.detectionId));
    if (extra?.owner_name) params.set('owner_name', extra.owner_name);
    if (extra?.owner_phone) params.set('owner_phone', extra.owner_phone);
    const panelBay = pa.panelLabel?.match(/bay[\s_\-]*#?\s*(\d{1,2})/i)?.[1]
      ?? pa.panelLabel?.match(/panel[\s_\-]*#?\s*(\d{1,2})/i)?.[1];
    const autoBay = extra?.assigned_bay ?? (panelBay ? parseInt(panelBay, 10) : undefined);
    if (autoBay != null) params.set('bay', String(autoBay));
    navigate(`/visits/new?${params.toString()}`);
  };

  const bg = pa.state === 'found' ? 'rgba(16,185,129,0.06)' : pa.state === 'not_found' ? 'rgba(245,158,11,0.06)' : pa.state === 'created' ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)';
  const border = pa.state === 'found' ? 'rgba(16,185,129,0.25)' : pa.state === 'not_found' ? 'rgba(245,158,11,0.25)' : pa.state === 'created' ? 'rgba(16,185,129,0.3)' : 'var(--border-light)';

  return (
    <div style={{ borderRadius: 14, border: `1px solid ${border}`, background: bg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Car size={15} color="var(--blue)" />
          </div>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {pa.plate}
          </span>
          {pa.vehicle && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {[pa.vehicle.make, pa.vehicle.model].filter(Boolean).join(' ') || ''}
            </span>
          )}
        </div>
        {/* State badge */}
        {pa.state === 'loading' && <Loader2 size={14} color="var(--blue)" style={{ animation: 'spin 1s linear infinite' }} />}
        {pa.state === 'found' && <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} /> In database</span>}
        {pa.state === 'not_found' && <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={12} /> Not registered</span>}
        {pa.state === 'created' && <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} /> Visit opened</span>}
        {pa.state === 'error' && <span style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={12} /> {pa.error}</span>}
      </div>

      {/* Found: show vehicle card */}
      {pa.state === 'found' && pa.vehicle && (
        <div style={{ background: 'var(--bg-surface)', borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border-light)' }}>
          <div className="rcols-2" style={{ display: 'grid', gap: '6px 16px', fontSize: 12, marginBottom: 10 }}>
            <span style={{ color: 'var(--text-muted)' }}>Owner</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{pa.vehicle.owner_name || '—'}</span>
            <span style={{ color: 'var(--text-muted)' }}>Phone</span>
            <span style={{ color: 'var(--text-primary)' }}>{pa.vehicle.owner_phone || '—'}</span>
            <span style={{ color: 'var(--text-muted)' }}>Total visits</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{pa.vehicle.total_visits}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '7px 16px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => openWorkOrderWizard()}
            >
              <Plus size={12} /> New work order
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => navigate(`/vehicles/${pa.vehicle!.id}`)}
            >
              <ArrowRight size={12} /> View profile
            </button>
          </div>
        </div>
      )}

      {/* Not found: register form */}
      {pa.state === 'not_found' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            This plate isn't in CarTrack yet. Fill in owner details to register and open a visit:
          </div>
          <div className="rcols-2-80" style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '6px 10px' }}>
              <User size={12} color="var(--text-muted)" />
              <input value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="Owner name" style={{ background: 'none', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text-primary)', width: '100%' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '6px 10px' }}>
              <Phone size={12} color="var(--text-muted)" />
              <input value={ownerPhone} onChange={e => setOwnerPhone(e.target.value)} placeholder="Phone" style={{ background: 'none', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text-primary)', width: '100%' }} />
            </div>
            <input value={bay} onChange={e => setBay(e.target.value)} placeholder="Bay #" type="number" min={1}
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '6px 10px', fontSize: 12, color: 'var(--text-primary)', outline: 'none' }} />
          </div>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '8px 18px', display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
            onClick={() => openWorkOrderWizard({
              owner_name: ownerName || undefined,
              owner_phone: ownerPhone || undefined,
              assigned_bay: bay ? parseInt(bay, 10) : undefined,
            })}
          >
            <Plus size={12} /> Register &amp; new work order
          </button>
        </div>
      )}

      {/* Visit created confirmation */}
      {pa.state === 'created' && pa.linkedVisitId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Visit opened successfully.</span>
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => navigate(`/visits/${pa.linkedVisitId}`)}>
            <ArrowRight size={11} /> Go to visit
          </button>
          <Link to="/visits" className="btn btn-secondary" style={{ fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}>
            All visits
          </Link>
        </div>
      )}

      {pa.state === 'creating' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Creating visit…
        </div>
      )}
    </div>
  );
};

/* ─────────────────────────── Main ──────────────────────────────────────────── */

export const VisionFlowStudio: React.FC = () => {
  const location = useLocation();
  const cloudAutostartDone = useRef(false);
  const [preset, setPreset] = useState('balanced');
  const [opts, setOpts] = useState<PipelineOpts>(PRESETS.balanced);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [liveSource, setLiveSource] = useState('dahua-hero-a1');
  const [liveRecord, setLiveRecord] = useState(true);
  const [liveAlwaysOn, setLiveAlwaysOn] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'info' } | null>(null);

  // ANPR integration state
  const [synced, setSynced] = useState<SyncedDetection[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [plateActions, setPlateActions] = useState<Record<string, PlateAction>>({});
  const hasSynced = useRef(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewActiveRef = useRef(false);
  const prevUrl = useRef<string | null>(null);

  useEffect(() => {
    camerasApi.getHeroLiveSource().then(res => {
      if (res.data.token) setLiveSource(res.data.token);
    }).catch(() => { /* keep dahua-hero-a1 default */ });
  }, []);

  const opt = <K extends keyof PipelineOpts>(k: K, v: PipelineOpts[K]) => { setPreset('custom'); setOpts(o => ({ ...o, [k]: v })); };
  const applyPreset = (p: string) => { if (PRESETS[p]) { setPreset(p); setOpts(PRESETS[p]); } };
  const toast$ = (msg: string, type: 'error' | 'info' = 'error') => { setToast({ msg, type }); setTimeout(() => setToast(null), 5500); };

  const stopPoll = useCallback(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }, []);
  const stopPreview = useCallback(() => {
    previewActiveRef.current = false;
    if (previewRef.current) {
      clearTimeout(previewRef.current);
      previewRef.current = null;
    }
  }, []);

  const startPreview = useCallback((id: string) => {
    stopPreview();
    previewActiveRef.current = true;
    let misses = 0;
    let delayMs = 600;

    const schedule = (ms: number) => {
      previewRef.current = setTimeout(tick, ms);
    };

    const tick = async () => {
      if (!previewActiveRef.current) return;
      try {
        const r = await fetch(`/vf/api/jobs/${encodeURIComponent(id)}/snapshot.jpg?t=${Date.now()}`, { cache: 'no-store' });
        if (r.status === 502 || r.status === 503) {
          misses += 1;
          delayMs = Math.min(5000, 1000 + misses * 500);
          schedule(delayMs);
          return;
        }
        if (r.status === 204 || !r.ok) {
          misses += 1;
          delayMs = Math.min(2500, 600 + misses * 250);
          schedule(delayMs);
          return;
        }
        misses = 0;
        delayMs = 85;
        const url = URL.createObjectURL(await r.blob());
        setPreviewSrc(url);
        if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
        prevUrl.current = url;
      } catch {
        misses += 1;
        delayMs = Math.min(3000, Math.round(delayMs * 1.4));
      }
      if (previewActiveRef.current) schedule(delayMs);
    };

    schedule(delayMs);
  }, [stopPreview]);

  /* ── Load sync state from CarTrack after job is done ── */
  const syncPlates = useCallback(async (doneJob: JobState, jId: string) => {
    if (hasSynced.current) return;
    hasSynced.current = true;
    setSyncStatus('syncing');

    // If the backend hasn't written yet (race condition), manually trigger
    // the sync endpoint as a fallback, then read
    try {
      await visionflowSyncApi.syncJob(jId);
    } catch { /* job may already be synced — that's fine */ }

    let detections: SyncedDetection[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await anprApi.byJob(jId);
        detections = res.data ?? [];
        if (detections.length > 0) break;
      } catch { /* noop */ }
      if (attempt < 3) await new Promise(r => setTimeout(r, 800));
    }

    if (detections.length === 0) {
      // Final fallback: push sync ourselves from the job manifest
      const validPlates = doneJob.vehicles.filter(v => v.plate && v.plate !== '—' && v.plate !== '…');
      if (validPlates.length > 0) {
        try {
          const res = await anprApi.sync(
            jId,
            doneJob.input_name,
            validPlates.map(v => ({
              plate: v.plate,
              speed_kmh: v.speed_kmh_avg ?? v.speed_kmh_max,
              track_id: v.track_id,
              t_enter_sec: v.t_enter_sec,
              t_exit_sec: v.t_exit_sec,
              duration_sec: v.duration_sec,
            }))
          );
          detections = res.data.detections ?? [];
        } catch { /* noop */ }
      }
    }

    setSynced(detections);
    setSyncStatus(detections.length > 0 ? 'done' : 'error');

    const actions: Record<string, PlateAction> = {};
    for (const d of detections) {
      actions[d.plate] = {
        plate: d.plate,
        detectionId: d.id,
        vehicle: d.vehicle,
        linkedVisitId: d.visit_id,
        state: d.vehicle ? 'found' : 'not_found',
      };
    }
    setPlateActions(actions);
  }, []);

  // Live ANPR counter: poll CarTrack DB during analysis to show plates as they land
  const liveAnprPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopLivePoll = useCallback(() => {
    if (liveAnprPollRef.current) { clearInterval(liveAnprPollRef.current); liveAnprPollRef.current = null; }
  }, []);

  const startLivePoll = useCallback((id: string, live = false) => {
    stopLivePoll();
    const intervalMs = live ? 12000 : 2500;
    liveAnprPollRef.current = setInterval(async () => {
      try {
        const res = await anprApi.byJob(id);
        const dets: SyncedDetection[] = res.data ?? [];
        if (dets.length === 0) return;
        setSynced(dets);
        setSyncStatus('done');
        const actions: Record<string, PlateAction> = {};
        for (const d of dets) {
          actions[d.plate] = {
            plate: d.plate,
            detectionId: d.id,
            vehicle: d.vehicle,
            linkedVisitId: d.visit_id,
            state: d.vehicle ? 'found' : 'not_found',
          };
        }
        setPlateActions(actions);
      } catch { /* backend may be busy during model load */ }
    }, intervalMs);
  }, [stopLivePoll]);

  const pollJob = useCallback(async (id: string) => {
    let r: Response;
    try {
      r = await fetch(`/vf/api/jobs/${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    if (r.status === 502 || r.status === 503) {
      setJob(prev => prev ? {
        ...prev,
        message: prev.message?.includes('Backend unavailable')
          ? prev.message
          : 'Backend reconnecting — live session may resume when the API is back (port 8001).',
      } : null);
      return;
    }
    if (!r.ok) return;
    const data: JobState = await r.json();
    setJob(data);
    if (data.status === 'done') {
      stopPoll(); stopPreview(); stopLivePoll();
      syncPlates(data, id);
    } else if (data.status === 'error') {
      stopPoll(); stopPreview(); stopLivePoll();
      toast$(data.message || 'Analysis failed');
    }
  }, [stopPoll, stopPreview, stopLivePoll, syncPlates]);

  const startAnalyze = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v'].includes(ext)) { toast$(`Unsupported format .${ext}`); return; }
    setFileInfo({ name: file.name, size: file.size });
    setPreviewSrc(null); setJobId(null);
    setSynced([]); setSyncStatus('idle'); setPlateActions({});
    hasSynced.current = false;
    setJob({ status: 'queued', progress: 0, message: 'Uploading…', processed_frames: 0, total_frames_est: 0, output_file: null, input_name: file.name, vehicles: [] });
    stopPoll(); stopPreview(); stopLivePoll();

    const fd = new FormData();
    fd.append('file', file, file.name);
    const p = opts;
    fd.append('conf', String(p.conf)); fd.append('iou', String(p.iou)); fd.append('stride', String(p.stride));
    fd.append('width', String(p.width)); fd.append('meter_per_pixel', String(p.meter_per_pixel));
    fd.append('max_speed', String(p.max_speed)); fd.append('speed_smooth', String(p.speed_smooth));
    fd.append('fps', String(p.fps)); fd.append('ocr_interval', String(p.ocr_interval));
    fd.append('min_ocr_conf', String(p.min_ocr_conf)); fd.append('track_imgsz', String(p.track_imgsz));
    fd.append('preview_jpeg_quality', String(p.preview_jpeg_quality));
    fd.append('prefer_fast_encoder', p.prefer_fast_encoder ? 'true' : 'false');

    try {
      const res = await fetch('/vf/api/analyze', { method: 'POST', body: fd });
      if (!res.ok) {
        let detail = 'Upload rejected';
        try { const j = await res.json(); if (j.detail) detail = String(j.detail); } catch { /* noop */ }
        setJob(prev => prev ? { ...prev, status: 'error', message: detail } : null);
        toast$(detail); return;
      }
      const { job_id } = await res.json();
      setJobId(job_id); startPreview(job_id); startLivePoll(job_id, false);
      pollJob(job_id).catch(() => {});
      pollRef.current = setInterval(() => pollJob(job_id).catch(() => { stopPoll(); stopPreview(); stopLivePoll(); toast$('Lost connection.'); }), 1500);
    } catch {
      setJob(prev => prev ? { ...prev, status: 'error', message: 'Network error' } : null);
      toast$('Network error — is the server running?');
    }
  }, [opts, stopPoll, stopPreview, stopLivePoll, startPreview, pollJob, startLivePoll]);

  const startLive = useCallback(async () => {
    const raw = liveSource.trim();
    const src = raw || '0';
    setFileInfo(null);
    setPreviewSrc(null); setJobId(null);
    setSynced([]); setSyncStatus('idle'); setPlateActions({});
    hasSynced.current = false;
    setJob({
      status: 'queued',
      progress: null,
      message: 'Connecting to source…',
      processed_frames: 0,
      total_frames_est: 0,
      output_file: null,
      input_name: raw ? `Live: ${src}` : 'Live: PC camera (0)',
      vehicles: [],
      is_live: true,
    });
    stopPoll(); stopPreview(); stopLivePoll();

    const fd = new FormData();
    fd.append('source', src);
    fd.append('record', liveRecord ? 'true' : 'false');
    fd.append('always_on', liveAlwaysOn ? 'true' : 'false');
    const p = opts;
    fd.append('conf', String(p.conf)); fd.append('iou', String(p.iou)); fd.append('stride', String(p.stride));
    fd.append('width', String(p.width)); fd.append('meter_per_pixel', String(p.meter_per_pixel));
    fd.append('max_speed', String(p.max_speed)); fd.append('speed_smooth', String(p.speed_smooth));
    fd.append('fps', String(p.fps)); fd.append('ocr_interval', String(p.ocr_interval));
    fd.append('min_ocr_conf', String(p.min_ocr_conf)); fd.append('track_imgsz', String(p.track_imgsz));
    fd.append('preview_jpeg_quality', String(p.preview_jpeg_quality));
    fd.append('prefer_fast_encoder', p.prefer_fast_encoder ? 'true' : 'false');

    try {
      const res = await visionflowApi.liveStart(fd);
      if (!res.ok) {
        let detail = 'Live start rejected';
        try { const j = await res.json(); if (j.detail) detail = String(j.detail); } catch { /* noop */ }
        setJob(prev => prev ? { ...prev, status: 'error', message: detail, progress: 0 } : null);
        toast$(detail); return;
      }
      const { job_id } = await res.json() as { job_id: string };
      setJobId(job_id); startPreview(job_id); startLivePoll(job_id, true);
      pollJob(job_id).catch(() => {});
      pollRef.current = setInterval(() => pollJob(job_id).catch(() => { stopPoll(); stopPreview(); stopLivePoll(); toast$('Lost connection.'); }), 1500);
    } catch {
      setJob(prev => prev ? { ...prev, status: 'error', message: 'Network error', progress: 0 } : null);
      toast$('Network error — is the server running?');
    }
  }, [liveSource, liveRecord, liveAlwaysOn, opts, stopPoll, stopPreview, stopLivePoll, startPreview, pollJob, startLivePoll]);

  useEffect(() => {
    const st = location.state as { fromCloudConnect?: boolean; autostartLive?: boolean; liveSource?: string } | null;
    if (!st?.autostartLive || cloudAutostartDone.current) return;
    cloudAutostartDone.current = true;
    if (st.liveSource) setLiveSource(st.liveSource);
    toast$('Camera connected — starting live analysis…', 'info');
    window.history.replaceState({}, document.title);
    const t = window.setTimeout(() => {
      void startLive();
    }, 400);
    return () => window.clearTimeout(t);
  }, [location.state, startLive]);

  const stopLive = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await visionflowApi.liveStop(jobId);
      if (!res.ok) {
        let detail = 'Stop request failed';
        try { const j = await res.json(); if (j.detail) detail = String(j.detail); } catch { /* noop */ }
        toast$(detail);
      }
    } catch {
      toast$('Could not reach server to stop live session');
    }
  }, [jobId]);

  const reset = () => {
    stopPoll(); stopPreview(); stopLivePoll();
    setJob(null); setJobId(null); setFileInfo(null); setPreviewSrc(null);
    setSynced([]); setSyncStatus('idle'); setPlateActions({}); hasSynced.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  useEffect(() => () => { stopPoll(); stopPreview(); stopLivePoll(); }, [stopPoll, stopPreview, stopLivePoll]);

  /* ── Derived ── */
  const running = job && (job.status === 'queued' || job.status === 'running');
  const done = job?.status === 'done';
  const errored = job?.status === 'error';
  const isLiveSession = Boolean(job?.is_live);
  const liveHealth = job?.live_health;
  const streamOk = Boolean(
    running
    && job?.status === 'running'
    && liveHealth?.stream_connected
    && liveHealth?.last_frame_at,
  );
  const liveIndeterminate = Boolean(running && isLiveSession && job?.progress == null);
  const progress = Math.max(0, Math.min(100, Number(job?.progress ?? 0)));
  const vehicleCount = job?.vehicles?.length ?? 0;
  const showPreviewPanel = Boolean(running || previewSrc);
  const fps = job?.video_fps && job.video_fps > 0 ? job.video_fps : (job?.analyze_options?.probe_video_fps ?? null);
  const statusMeta = done
    ? { label: 'Complete', color: '#10b981' }
    : errored
      ? { label: 'Failed', color: '#ef4444' }
      : running
        ? {
            label: job?.status === 'queued'
              ? (isLiveSession ? 'Connecting…' : 'Queued')
              : (isLiveSession ? (job?.always_on ? '24/7 Live' : 'Live') : 'Analyzing'),
            color: '#3b82f6',
          }
        : { label: 'Idle', color: 'var(--text-muted)' };

  const linkedCount = Object.values(plateActions).filter(p => p.vehicle !== null).length;
  const actionablePlates = Object.values(plateActions).filter(pa => pa.state !== 'idle');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ══ HERO ══ */}
      <div style={{ position: 'relative', borderRadius: 20, overflow: 'hidden', marginBottom: 24, background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(139,92,246,0.06) 50%, rgba(16,185,129,0.05) 100%)', border: '1px solid var(--border-light)', padding: '28px 32px' }}>
        <div style={{ position: 'absolute', top: -60, right: 60, width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0, background: 'linear-gradient(135deg, rgba(59,130,246,0.2), rgba(139,92,246,0.15))', border: '1px solid rgba(59,130,246,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 24px rgba(59,130,246,0.15)' }}>
              <ScanLine size={24} color="#3b82f6" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.3px' }}>ANPR &amp; Speed Analyzer</h1>
                <Tag color="#3b82f6">YOLO11</Tag>
                <Tag color="#8b5cf6">ByteTrack</Tag>
                <Tag color="#10b981">EasyOCR</Tag>
                <Tag color="#f59e0b">CarTrack linked</Tag>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 580 }}>
                Detect vehicles, read licence plates and estimate speeds from traffic video — then instantly link every plate to your CarTrack database to open visits or view profiles.
              </p>
            </div>
          </div>
          <div className="vf-hero-actions page-hero-actions" style={{ flexShrink: 0 }}>
            <Link to="/visionflow/multicam" className="btn btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <Grid2X2 size={14} /> Camera wall
            </Link>
            <Link to="/visionflow/history" className="btn btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <History size={14} /> History
            </Link>
            {(job || fileInfo) && (
              <button className="btn btn-ghost" onClick={reset} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <X size={14} /> New upload
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ══ PIPELINE ACCORDION ══ */}
      <div style={{ borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', overflow: 'hidden', marginBottom: 20 }}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={pipelineOpen}
          onClick={() => setPipelineOpen(o => !o)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPipelineOpen(o => !o);
            }
          }}
          style={{
            width: '100%',
            padding: '14px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'none',
            border: 'none',
            borderBottom: pipelineOpen ? '1px solid var(--border-light)' : 'none',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'inherit',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--blue-dim)', border: '1px solid rgba(59,130,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Gauge size={14} color="var(--blue)" />
          </div>
          <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Pipeline &amp; calibration</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{preset === 'custom' ? 'Custom settings' : `${preset.charAt(0).toUpperCase() + preset.slice(1)} preset`} · conf {opts.conf} · stride {opts.stride} · {opts.width}px</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            {(['fast', 'balanced', 'accurate'] as const).map(p => (
              <button key={p} type="button" onClick={() => applyPreset(p)}
                style={{ padding: '4px 12px', borderRadius: 99, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid', background: preset === p ? 'var(--blue)' : 'transparent', color: preset === p ? '#fff' : 'var(--text-secondary)', borderColor: preset === p ? 'var(--blue)' : 'var(--border)', display: 'flex', alignItems: 'center', gap: 4 }}>
                {p === 'fast' && <Zap size={10} />}
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
            <span style={{ color: 'var(--text-muted)', display: 'flex' }} aria-hidden>{pipelineOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
          </div>
        </div>
        {pipelineOpen && (
          <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
              <SlimField label="Confidence"><NumIn value={opts.conf} onChange={v => opt('conf', v)} min={0.05} max={0.9} step={0.01} /></SlimField>
              <SlimField label="NMS IoU"><NumIn value={opts.iou} onChange={v => opt('iou', v)} min={0.2} max={0.9} step={0.01} /></SlimField>
              <SlimField label="Frame stride" hint="Skip N−1 frames"><NumIn value={opts.stride} onChange={v => opt('stride', Math.round(v))} min={1} max={8} step={1} /></SlimField>
              <SlimField label="Resize width (px)"><NumIn value={opts.width} onChange={v => opt('width', Math.round(v))} min={480} max={1920} step={8} /></SlimField>
              <SlimField label="Meters / pixel" hint="Calibrate vs. known dist."><NumIn value={opts.meter_per_pixel} onChange={v => opt('meter_per_pixel', v)} min={0.001} max={0.3} step={0.001} /></SlimField>
              <SlimField label="Speed cap (km/h)"><NumIn value={opts.max_speed} onChange={v => opt('max_speed', v)} min={30} max={300} step={1} /></SlimField>
              <SlimField label="Speed smoothing"><NumIn value={opts.speed_smooth} onChange={v => opt('speed_smooth', v)} min={0.05} max={0.95} step={0.02} /></SlimField>
              <SlimField label="FPS override" hint="0 = read from file"><NumIn value={opts.fps} onChange={v => opt('fps', v)} min={0} max={120} step={0.1} /></SlimField>
              <SlimField label="OCR every N frames"><NumIn value={opts.ocr_interval} onChange={v => opt('ocr_interval', Math.round(v))} min={1} max={12} step={1} /></SlimField>
              <SlimField label="Min OCR confidence"><NumIn value={opts.min_ocr_conf} onChange={v => opt('min_ocr_conf', v)} min={0} max={1} step={0.02} /></SlimField>
              <SlimField label="Track imgsz"><NumIn value={opts.track_imgsz} onChange={v => opt('track_imgsz', Math.round(v))} min={640} max={1600} step={32} /></SlimField>
              <SlimField label="Preview JPEG quality"><NumIn value={opts.preview_jpeg_quality} onChange={v => opt('preview_jpeg_quality', Math.round(v))} min={45} max={95} step={1} /></SlimField>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={opts.prefer_fast_encoder} onChange={e => opt('prefer_fast_encoder', e.target.checked)} style={{ accentColor: 'var(--blue)' }} />
              Faster export encoder (slightly larger files)
            </label>
          </div>
        )}
      </div>

      {/* ══ DROP ZONE + LIVE ══ */}
      {!job && (
        <>
        <div
          onDragEnter={e => { e.preventDefault(); setDragging(true); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) startAnalyze(f);
          }}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
          tabIndex={0}
          aria-label="Upload traffic video — drop a file or press Enter to browse"
          style={{ position: 'relative', borderRadius: 20, border: `2px dashed ${dragging ? '#3b82f6' : 'var(--border)'}`, background: dragging ? 'linear-gradient(135deg, rgba(59,130,246,0.06), rgba(139,92,246,0.04))' : 'var(--bg-surface)', padding: '56px 32px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s', outline: 'none' }}
        >
          {dragging && <div style={{ position: 'absolute', inset: 4, borderRadius: 16, border: '1px solid rgba(59,130,246,0.3)', animation: 'vfRingPulse 1s ease-in-out infinite', pointerEvents: 'none' }} />}
          <div style={{ width: 64, height: 64, borderRadius: 18, margin: '0 auto 20px', background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.1))', border: '1px solid rgba(59,130,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 32px rgba(59,130,246,0.1)' }}>
            <Upload size={28} color="#3b82f6" strokeWidth={1.5} />
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 10px', letterSpacing: '-0.2px' }}>{dragging ? 'Drop to start analysis' : 'Drop your traffic video'}</h2>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '0 auto 24px', maxWidth: 420, lineHeight: 1.65 }}>Drag and drop an MP4, MOV, MKV, AVI, or WEBM file. Detected plates are automatically linked to your CarTrack vehicle database.</p>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 28 }}>
            {['MP4', 'MOV', 'MKV', 'AVI', 'WEBM'].map(f => <span key={f} style={{ padding: '3px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', color: 'var(--text-muted)' }}>{f}</span>)}
          </div>
          <span
            className="btn btn-primary"
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                fileInputRef.current?.click();
              }
            }}
            style={{ fontSize: 14, padding: '11px 28px', display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Upload size={15} /> Choose file
          </span>
          <input ref={fileInputRef} type="file" style={{ display: 'none' }} accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska,.mkv,.mov,.avi,.webm,.m4v" onChange={e => { const f = e.target.files?.[0]; if (f) startAnalyze(f); }} />
        </div>

        <div style={{ marginTop: 20, borderRadius: 20, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0, background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(59,130,246,0.1))', border: '1px solid rgba(16,185,129,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Webcam size={22} color="#10b981" strokeWidth={1.5} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px', letterSpacing: '-0.2px' }}>Live camera or stream</h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 640 }}>
                Uses the camera on the machine running the <strong>backend</strong>. Leave source empty or enter <code style={{ fontSize: 12 }}>0</code> for the built-in laptop/PC webcam. For the <strong>Dahua Hero A1</strong>, configure it below (connects via <strong>Cloud / Easy4IP P2P</strong> — no LAN needed; USB-C is power only) and use source <code style={{ fontSize: 12 }}>dahua-hero-a1</code>. Enable <strong>24/7 mode</strong> for auto-reconnect.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 220px', minWidth: 180 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Source</span>
              <input
                type="text"
                value={liveSource}
                onChange={e => setLiveSource(e.target.value)}
                placeholder="0 = PC webcam · dahua-hero-a1 · rtsp://…"
                autoComplete="off"
                spellCheck={false}
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', paddingBottom: 8 }}>
              <input type="checkbox" checked={liveRecord} onChange={e => setLiveRecord(e.target.checked)} style={{ accentColor: 'var(--blue)' }} />
              Record annotated video (hourly segments)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', paddingBottom: 8 }}>
              <input type="checkbox" checked={liveAlwaysOn} onChange={e => setLiveAlwaysOn(e.target.checked)} style={{ accentColor: '#10b981' }} />
              24/7 mode (auto-reconnect &amp; resume on restart)
            </label>
            <button type="button" className="btn btn-primary" onClick={() => void startLive()} style={{ fontSize: 14, padding: '10px 22px', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Webcam size={16} /> {liveAlwaysOn ? 'Start 24/7 live' : 'Start live analysis'}
            </button>
          </div>
          <DahuaHeroA1Panel compact onUseAsSource={token => { setLiveSource(token); toast$('Live source set to DH-H3A — click Start live analysis', 'info'); }} />
        </div>
        </>
      )}

      {/* ══ JOB PANEL ══ */}
      {job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Status bar */}
          <div style={{ borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: statusMeta.color, boxShadow: running ? `0 0 0 4px ${statusMeta.color}20` : 'none', animation: running ? 'vfPulse 1.1s ease-in-out infinite' : 'none' }} />
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{statusMeta.label}</span>
                {fileInfo ? (
                  <span style={{ padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileInfo.name} · {fmtBytes(fileInfo.size)}</span>
                ) : job?.input_name ? (
                  <span title={job.input_name} style={{ padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.input_name}</span>
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {/* Sync status */}
                {syncStatus === 'syncing' && <span style={{ fontSize: 11, color: 'var(--blue)', display: 'flex', alignItems: 'center', gap: 5 }}><Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Syncing…</span>}
                {running && synced.length > 0 && <span style={{ fontSize: 11, color: '#06b6d4', display: 'flex', alignItems: 'center', gap: 5 }}><Link2 size={11} /> {synced.length} plates live in CarTrack</span>}
                {!running && syncStatus === 'done' && <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 5 }}><Link2 size={11} /> {linkedCount}/{synced.length} plates linked</span>}
                {running && <Loader2 size={14} color="var(--blue)" style={{ animation: 'spin 1s linear infinite' }} />}
                {done && <CheckCircle2 size={14} color="#10b981" />}
                {errored && <AlertCircle size={14} color="#ef4444" />}
                {running && isLiveSession && jobId && (
                  <button type="button" className="btn btn-secondary" onClick={() => void stopLive()} style={{ fontSize: 12, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    Stop live
                  </button>
                )}
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{liveIndeterminate ? 'LIVE' : `${Math.round(progress)}%`}</span>
              </div>
            </div>
            <div style={{ height: 5, borderRadius: 99, background: 'var(--border)', overflow: 'hidden', position: 'relative' }}>
              {liveIndeterminate ? (
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: '38%',
                    borderRadius: 99,
                    background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
                    animation: 'vfLiveBar 1.15s ease-in-out infinite alternate',
                    boxShadow: '0 0 8px rgba(59,130,246,0.45)',
                  }}
                />
              ) : (
                <div style={{ height: '100%', width: `${progress}%`, borderRadius: 99, background: errored ? '#ef4444' : done ? '#10b981' : 'linear-gradient(90deg, #3b82f6, #8b5cf6)', transition: 'width 0.4s ease', boxShadow: !errored && !done ? '0 0 8px rgba(59,130,246,0.5)' : 'none' }} />
              )}
            </div>
            {job.message && <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{job.message}</p>}
            {isLiveSession && liveHealth && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 99, background: streamOk ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', color: streamOk ? '#10b981' : '#f59e0b', border: `1px solid ${streamOk ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.25)'}` }}>
                  {streamOk ? 'Stream connected' : 'Reconnecting…'}
                </span>
                {liveHealth.reconnect_count != null && liveHealth.reconnect_count > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px' }}>Reconnects: {liveHealth.reconnect_count}</span>
                )}
                {liveHealth.uptime_sec != null && liveHealth.uptime_sec > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px' }}>Uptime: {Math.floor(liveHealth.uptime_sec / 60)}m</span>
                )}
                {liveHealth.segments && liveHealth.segments.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px' }}>Segments: {liveHealth.segments.length}</span>
                )}
                {job.always_on && (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 99, background: 'rgba(59,130,246,0.1)', color: '#3b82f6' }}>24/7 protected</span>
                )}
              </div>
            )}
          </div>

          {/* Stat pills */}
          {(vehicleCount > 0 || job.processed_frames > 0) && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <StatPill icon={<Activity size={14} color="#3b82f6" />} label="Frames" value={job.total_frames_est > 0 ? `${job.processed_frames} / ${job.total_frames_est}` : String(job.processed_frames)} />
              {fps && fps > 0 && <StatPill icon={<Video size={14} color="#8b5cf6" />} label="Source FPS" value={`${(+fps).toFixed(2)} fps`} color="#8b5cf6" />}
              <StatPill icon={<TrendingUp size={14} color="#10b981" />} label="Tracks" value={vehicleCount} color="#10b981" />
              {vehicleCount > 0 && (() => { const p = Math.max(...job.vehicles.map(v => v.speed_kmh_max ?? 0)); return p > 0 ? <StatPill icon={<Gauge size={14} color="#f59e0b" />} label="Peak speed" value={`${p} km/h`} color="#f59e0b" /> : null; })()}
              {syncStatus === 'done' && <StatPill icon={<Link2 size={14} color="#06b6d4" />} label="DB linked" value={`${linkedCount} / ${synced.length}`} color="#06b6d4" />}
            </div>
          )}

          {/* Registry + preview */}
          <div className={`vf-job-split${showPreviewPanel ? ' has-preview' : ''}`}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border-light)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}><Eye size={12} /> Vehicle registry</span>
                {vehicleCount > 0 && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 99, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)' }}>{vehicleCount} track{vehicleCount !== 1 ? 's' : ''}</span>}
              </div>
              <div className="table-scroll" style={{ overflowY: 'auto', maxHeight: 320, flex: 1 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-elevated)' }}>
                      {['#', 'ID', 'Plate', 'OCR', 'Peak', 'Avg', 'Last', 'Enter', 'Exit', 'Dwell', 'DB', 'Status'].map((h, hi) => (
                        <th key={h || `col-${hi}`} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {vehicleCount === 0 ? (
                      <tr><td colSpan={12} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 12 }}>Waiting for tracked vehicles…</td></tr>
                    ) : job.vehicles.map((v, i) => {
                      const pa = plateActions[v.plate];
                      const isLinked = pa?.vehicle !== null && pa !== undefined;
                      return (
                        <tr key={`${v.track_id ?? 'n'}-${v.status}-${v.first_frame ?? 0}-${i}`} style={{ borderBottom: '1px solid var(--border-light)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                          <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{i + 1}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{v.track_id ?? '—'}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-primary)' }}>{v.plate || '—'}</td>
                          <td style={{ padding: '8px 10px' }}>
                            <PlateConfidenceCell
                              confidence={v.ocr_confidence}
                              votes={v.ocr_vote_count}
                              segments={v.segment_count}
                            />
                          </td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{v.speed_kmh_max != null ? <span style={{ color: '#f59e0b', fontWeight: 600 }}>{v.speed_kmh_max}</span> : '—'}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{v.speed_kmh_avg != null ? <span style={{ color: '#3b82f6', fontWeight: 600 }}>{v.speed_kmh_avg}</span> : '—'}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{v.speed_kmh_last ?? '—'}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{fmtClock(v.t_enter_sec)}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{fmtClock(v.t_exit_sec)}</td>
                          <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{v.duration_sec != null ? v.duration_sec.toFixed(2) + 's' : '—'}</td>
                          <td style={{ padding: '8px 10px' }}>
                            {syncStatus === 'done' && pa ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 99, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', background: isLinked ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.1)', color: isLinked ? '#10b981' : '#f59e0b', border: `1px solid ${isLinked ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.2)'}` }}>
                                {isLinked ? <><Link2 size={8} /> linked</> : 'new'}
                              </span>
                            ) : syncStatus === 'syncing' ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} /> : '—'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <PlateTrackStatusBadge status={v.status} resumeEligible={v.resume_eligible} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {showPreviewPanel && (
              <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border-light)', background: '#030407', display: 'flex', flexDirection: 'column', minHeight: 280 }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgba(210,220,255,0.6)', display: 'flex', alignItems: 'center', gap: 6 }}><Eye size={12} /> Live preview</span>
                  {running && previewSrc && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: '#3b82f6', fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', animation: 'vfPulse 1s ease-in-out infinite' }} /> Streaming</span>}
                  {running && !previewSrc && <span style={{ fontSize: 10.5, color: 'rgba(210,220,255,0.45)', fontWeight: 600 }}>Waiting for frames…</span>}
                  {done && <span style={{ fontSize: 10.5, color: '#10b981', fontWeight: 600 }}>Analysis complete</span>}
                </div>
                <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: '#030407', minHeight: 220 }}>
                  {previewSrc ? (
                    <img src={previewSrc} alt="Live tracking preview" style={{ width: '100%', height: 'auto', maxHeight: 300, objectFit: 'contain', display: 'block' }} />
                  ) : (
                    <div style={{ textAlign: 'center', padding: 24, color: 'rgba(210,220,255,0.45)' }}>
                      <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', marginBottom: 12, opacity: 0.7 }} />
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {isLiveSession ? (job?.message || 'Opening camera & loading AI models…') : 'Preparing preview…'}
                      </div>
                      <div style={{ fontSize: 11, marginTop: 6, opacity: 0.75 }}>
                        First run can take 30–90 seconds while YOLO and OCR load.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ══ PLATE ACTION PANEL (shown after sync) ══ */}
          {syncStatus === 'done' && actionablePlates.length > 0 && (
            <div style={{ borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Link2 size={13} color="#06b6d4" />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Plate actions — linked to CarTrack</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      {linkedCount} of {actionablePlates.length} plates found in vehicle database · click to open visits or register new vehicles
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Link to="/vehicles" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Search size={11} /> Vehicle DB
                  </Link>
                  <Link to="/visits" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Clock size={11} /> All visits
                  </Link>
                </div>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {actionablePlates.map(pa => (
                  <PlateActionCard key={pa.plate} pa={pa} />
                ))}
              </div>
            </div>
          )}

          {/* Action row */}
          <div style={{ borderRadius: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-light)', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href={done && jobId ? `/vf/api/jobs/${encodeURIComponent(jobId)}/video` : '#'} className="btn btn-primary"
                style={{ textDecoration: 'none', fontSize: 13, padding: '9px 20px', display: 'inline-flex', alignItems: 'center', gap: 7, opacity: done && jobId ? 1 : 0.4, pointerEvents: done && jobId ? 'auto' : 'none' }} download>
                <DownloadCloud size={14} /> Download annotated video
              </a>
              <button className="btn btn-secondary" disabled={!done || vehicleCount === 0}
                onClick={() => exportCsv(job.vehicles)} style={{ fontSize: 13, padding: '9px 18px', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <FileText size={14} /> Export CSV
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {done && vehicleCount > 0 && (
                <span style={{ fontSize: 12, color: '#10b981', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <CheckCircle2 size={12} /> {vehicleCount} vehicle{vehicleCount !== 1 ? 's' : ''} logged
                </span>
              )}
              <Link to="/visionflow/history" style={{ fontSize: 12, color: 'var(--blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={12} /> View history
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--bg-elevated)', border: `1px solid ${toast.type === 'error' ? 'rgba(239,68,68,0.4)' : 'rgba(6,182,212,0.4)'}`, borderRadius: 14, padding: '12px 16px', fontSize: 13, color: 'var(--text-primary)', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', gap: 10, maxWidth: 400, animation: 'vfToastIn 0.3s ease' }}>
          {toast.type === 'error' ? <AlertCircle size={15} color="#ef4444" /> : <CheckCircle2 size={15} color="#06b6d4" />}
          <span style={{ flex: 1 }}>{toast.msg}</span>
          <button onClick={() => setToast(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}><X size={14} /></button>
        </div>
      )}

      <style>{`
        @keyframes vfPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.85)} }
        @keyframes vfRingPulse { 0%,100%{opacity:.5} 50%{opacity:1} }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes vfToastIn { from{transform:translateY(12px);opacity:0} to{transform:translateY(0);opacity:1} }
        @keyframes vfLiveBar { 0% { left: 0; } 100% { left: 62%; } }
      `}</style>
    </div>
  );
};

export default VisionFlowStudio;
