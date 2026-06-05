import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Webcam, Power, PowerOff, Loader2, Activity, Car,
  RefreshCw, Grid2X2, AlertCircle, Link2, History, Gauge,
  Eye, Monitor, Wifi, Clock, Search, CheckCircle2,
} from 'lucide-react';
import { anprApi, camerasApi, visionflowApi, visionflowSyncApi } from '../../services/api';
import {
  PlateActionCard,
  detectionsToPlateActions,
  plateActionKey,
  type PlateAction,
  type SyncedDetection,
} from './VisionFlowPlateActions';
import {
  PlateConfidenceCell,
  PlateTrackStatusBadge,
  type VisionFlowVehicleRow,
} from './VisionFlowPlateQuality';

interface VehicleRow extends VisionFlowVehicleRow {}

interface LiveHealth {
  stream_connected?: boolean;
  processed_frames?: number;
  message?: string;
  last_frame_at?: string | null;
}

interface JobState {
  status: string;
  message: string;
  processed_frames: number;
  vehicles: VehicleRow[];
  live_health?: LiveHealth;
  is_live?: boolean;
}

interface GridSlot {
  slot: number;
  source: string;
  label: string;
  enabled: boolean;
  running: boolean;
  job_id: string | null;
  session_id: string | null;
  camera_available: boolean | null;
  camera_probe?: { index: number; width: number; height: number; fps: number } | null;
  job: JobState | null;
}

interface GridResponse {
  max_cameras: number;
  active_feeds: number;
  slots: GridSlot[];
  probed_cameras?: { index: number; width: number; height: number; fps: number; in_use?: boolean }[];
  cameras_busy?: boolean;
}

const fmtClock = (sec: number | null | undefined) => {
  if (sec == null || Number.isNaN(+sec)) return '—';
  const t = Math.max(0, +sec);
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};

/** Human-readable panel title — slot 0 is always the PC/laptop webcam index. */
function panelTitle(slot: number, source: string): string {
  const s = source.trim().toLowerCase();
  const isDahua =
    s === 'dahua-hero-a1' || s === 'dahua' || s === 'hero-a1' || s.includes('/cam/realmonitor');
  if (slot === 0 && isDahua) return 'Panel 1 — DH-H3A (Wi-Fi)';
  if (slot === 0 && (!s || s === '0' || s === 'webcam')) return 'Panel 1 — PC / laptop camera';
  return `Panel ${slot + 1} — USB camera #${slot}`;
}

function panelSubtitle(slot: number, source: string): string {
  const s = source.trim();
  if (s === 'dahua-hero-a1' || s === 'dahua' || s === 'hero-a1') {
    return 'Source: DH-H3A (saved Wi-Fi RTSP from Settings)';
  }
  if (!s || s === '0' || s.toLowerCase() === 'webcam') {
    return slot === 0
      ? 'Source: index 0 (built-in or default USB webcam on the server PC)'
      : `Source: index ${slot}`;
  }
  if (s.startsWith('rtsp') || s.startsWith('http')) {
    return `Source: IP stream · ${s.length > 52 ? s.slice(0, 52) + '…' : s}`;
  }
  return `Source: index ${s}`;
}

const QUICK_SOURCES = [
  { value: 'dahua-hero-a1', label: 'DH-H3A (Dahua Wi-Fi)', icon: Wifi, hint: 'Saved camera from Settings — use this for the Hero A1' },
  { value: '0', label: 'PC cam (0)', icon: Monitor, hint: 'Laptop / built-in webcam on the server PC' },
  { value: '1', label: 'USB #1', icon: Webcam, hint: 'Second USB camera' },
  { value: '2', label: 'USB #2', icon: Webcam, hint: 'Third USB camera' },
  { value: '3', label: 'USB #3', icon: Webcam, hint: 'Fourth USB camera' },
] as const;

const VehicleRegistry: React.FC<{
  vehicles: VehicleRow[];
  compact?: boolean;
  jobId?: string | null;
  plateActions?: Record<string, PlateAction>;
}> = ({ vehicles, compact, jobId, plateActions }) => {
  const rows = vehicles.filter(v => v.plate && v.plate !== '—' && v.plate !== '…');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: compact ? undefined : 1 }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-elevated)' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Eye size={11} /> Vehicle registry
        </span>
        {rows.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 7px', borderRadius: 99, border: '1px solid var(--border-light)' }}>
            {rows.length} track{rows.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div style={{ overflowY: 'auto', maxHeight: compact ? 140 : 220 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface)' }}>
              {['#', 'Plate', 'OCR', 'Peak', 'Avg', 'Dwell', 'CarTrack', 'Status'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '16px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                  Waiting for tracked vehicles…
                </td>
              </tr>
            ) : rows.map((v, i) => {
              const pa = jobId && plateActions ? plateActions[plateActionKey(jobId, v.plate)] : undefined;
              const linked = pa?.vehicle != null;
              return (
              <tr key={`${v.track_id}-${i}`} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{i + 1}</td>
                <td style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.05em' }}>{v.plate}</td>
                <td style={{ padding: '6px 8px' }}>
                  <PlateConfidenceCell
                    confidence={v.ocr_confidence}
                    votes={v.ocr_vote_count}
                    segments={v.segment_count}
                    compact
                  />
                </td>
                <td style={{ padding: '6px 8px', color: '#f59e0b', fontWeight: 600 }}>{v.speed_kmh_max ?? '—'}</td>
                <td style={{ padding: '6px 8px', color: '#3b82f6', fontWeight: 600 }}>{v.speed_kmh_avg ?? '—'}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{v.duration_sec != null ? `${v.duration_sec.toFixed(1)}s` : '—'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {pa ? (
                    <span style={{
                      fontSize: 8, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 99,
                      background: linked ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.1)',
                      color: linked ? '#10b981' : '#f59e0b',
                      border: `1px solid ${linked ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.2)'}`,
                    }}>
                      {linked ? 'linked' : pa.detectionId ? 'synced' : '…'}
                    </span>
                  ) : '—'}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <PlateTrackStatusBadge status={v.status} resumeEligible={v.resume_eligible} compact />
                </td>
              </tr>
            );})}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const CameraTile: React.FC<{
  slot: GridSlot;
  sourceDraft: string;
  onSourceChange: (v: string) => void;
  onToggle: (enable: boolean) => void;
  busy: boolean;
  isPcCameraPanel: boolean;
  plateActions?: Record<string, PlateAction>;
}> = ({ slot, sourceDraft, onSourceChange, onToggle, busy, isPcCameraPanel, plateActions }) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [showIpHint, setShowIpHint] = useState(false);
  const prevUrl = useRef<string | null>(null);
  const activeRef = useRef(true);
  const ipInputRef = useRef<HTMLInputElement>(null);

  const job = slot.job;
  const active = Boolean(
    slot.job_id && slot.running && job && (job.status === 'running' || job.status === 'queued'),
  );
  const running = active && job?.status === 'running';
  const locked = active || busy;
  const loading = active && !preview && job?.status !== 'error';
  const vehicles = job?.vehicles ?? [];
  const health = job?.live_health;
  const streamOk = Boolean(running && health?.stream_connected && health?.last_frame_at);
  const plateCount = vehicles.filter(v => v.plate && v.plate !== '—').length;
  const isIpSource = /^rtsp|^http/i.test(sourceDraft.trim());

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    if (!slot.job_id || !active) {
      setPreview(null);
      return undefined;
    }
    let delay = 600;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!activeRef.current) return;
      try {
        const r = await fetch(`${visionflowApi.snapshotUrl(slot.job_id!)}?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok && r.status !== 204) {
          misses = 0;
          delay = 120;
          const url = URL.createObjectURL(await r.blob());
          setPreview(url);
          if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
          prevUrl.current = url;
        } else {
          misses += 1;
          delay = Math.min(2500, 600 + misses * 300);
        }
      } catch {
        misses += 1;
        delay = Math.min(3000, delay * 1.3);
      }
      if (activeRef.current) timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, delay);
    return () => {
      clearTimeout(timer);
      if (prevUrl.current) {
        URL.revokeObjectURL(prevUrl.current);
        prevUrl.current = null;
      }
    };
  }, [slot.job_id, active]);

  return (
    <div style={{
      borderRadius: 16, overflow: 'hidden',
      border: `1px solid ${isPcCameraPanel ? 'rgba(16,185,129,0.35)' : running ? 'rgba(59,130,246,0.35)' : 'var(--border-light)'}`,
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', minHeight: 0,
      boxShadow: isPcCameraPanel && !running ? '0 0 0 1px rgba(16,185,129,0.08)' : undefined,
    }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-light)', background: isPcCameraPanel ? 'rgba(16,185,129,0.06)' : 'var(--bg-elevated)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: running ? 'rgba(16,185,129,0.15)' : isPcCameraPanel ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
            border: `1px solid ${running || isPcCameraPanel ? 'rgba(16,185,129,0.3)' : 'var(--border-light)'}`,
            display: 'grid', placeItems: 'center',
          }}>
            {isPcCameraPanel ? <Monitor size={15} color="#10b981" /> : <Webcam size={15} color={running ? '#10b981' : '#64748b'} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {panelTitle(slot.slot, sourceDraft)}
              {isPcCameraPanel && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.25)' }}>
                  INDEX 0
                </span>
              )}
              {slot.camera_available === true && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(59,130,246,0.1)', color: '#3b82f6' }}>DETECTED</span>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{panelSubtitle(slot.slot, sourceDraft)}</div>
          </div>
          {streamOk && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'vfPulse 1s ease-in-out infinite' }} /> LIVE
            </span>
          )}
          <button type="button" disabled={busy} onClick={() => onToggle(!locked)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none',
            cursor: busy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 700,
            background: locked ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.15)',
            color: locked ? '#ef4444' : '#10b981', opacity: busy ? 0.6 : 1,
          }}>
            {busy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : locked ? <PowerOff size={12} /> : <Power size={12} />}
            {locked ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      {/* Source config — always visible; disabled only while feed is running */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-surface)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
          Camera source (USB index or IP / RTSP URL)
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {QUICK_SOURCES.map(q => (
            <button
              key={q.value}
              type="button"
              disabled={locked}
              title={q.hint}
              onClick={() => { onSourceChange(q.value); setShowIpHint(false); }}
              style={{
                padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: locked ? 'not-allowed' : 'pointer',
                border: `1px solid ${sourceDraft.trim() === q.value ? 'rgba(59,130,246,0.5)' : 'var(--border-light)'}`,
                background: sourceDraft.trim() === q.value ? 'rgba(59,130,246,0.12)' : 'var(--bg-elevated)',
                color: sourceDraft.trim() === q.value ? '#3b82f6' : 'var(--text-secondary)',
                opacity: locked ? 0.55 : 1,
              }}
            >
              {q.label}
            </button>
          ))}
          <button
            type="button"
            disabled={locked}
            onClick={() => { setShowIpHint(true); setTimeout(() => ipInputRef.current?.focus(), 50); }}
            style={{
              padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: locked ? 'not-allowed' : 'pointer',
              border: `1px solid ${isIpSource || showIpHint ? 'rgba(139,92,246,0.5)' : 'var(--border-light)'}`,
              background: isIpSource || showIpHint ? 'rgba(139,92,246,0.12)' : 'var(--bg-elevated)',
              color: isIpSource || showIpHint ? '#8b5cf6' : 'var(--text-secondary)',
              display: 'inline-flex', alignItems: 'center', gap: 5, opacity: locked ? 0.55 : 1,
            }}
          >
            <Wifi size={12} /> IP / RTSP camera
          </button>
        </div>
        <label style={{ display: 'block' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
            {isIpSource || showIpHint
              ? 'Paste IP camera RTSP or HTTP URL (must be reachable from the server PC)'
              : 'Enter 0 for PC webcam, 1–3 for extra USB cameras, or rtsp://user:pass@192.168.x.x/stream'}
          </span>
          <input
            ref={ipInputRef}
            type="text"
            value={sourceDraft}
            onChange={e => onSourceChange(e.target.value)}
            disabled={locked}
            placeholder={slot.slot === 0 ? '0  (PC camera)  or  rtsp://192.168.1.64:554/stream1' : `${slot.slot}  or  rtsp://192.168.1.64:554/stream1`}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%', padding: '9px 12px', borderRadius: 10,
              border: `1px solid ${isIpSource ? 'rgba(139,92,246,0.4)' : 'var(--border-light)'}`,
              background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              opacity: locked ? 0.65 : 1,
            }}
          />
        </label>
        {locked && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Stop the feed to change the camera source.
          </div>
        )}
      </div>

      {/* Preview */}
      <div style={{ position: 'relative', aspectRatio: '16/9', background: '#030407', flexShrink: 0 }}>
        {preview ? (
          <img src={preview} alt={panelTitle(slot.slot, sourceDraft)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center' }}>
            {loading ? (
              <>
                <Loader2 size={32} color="#3b82f6" style={{ animation: 'spin 1s linear infinite', marginBottom: 10 }} />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{job?.message || 'Loading AI & opening camera…'}</div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {isPcCameraPanel
                  ? 'Press Start to open PC camera (index 0) on the server'
                  : slot.camera_available === false
                    ? 'No camera detected at this index — try IP/RTSP or another USB #'
                    : 'Press Start to begin live analysis'}
              </div>
            )}
          </div>
        )}
        {running && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6 }}>
            <span style={{ padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,0,0,0.65)', color: 'var(--text-accent)' }}>
              <Activity size={9} style={{ display: 'inline', marginRight: 4 }} />{job?.processed_frames ?? 0} frames
            </span>
            <span style={{ padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,0,0,0.65)', color: 'var(--text-success)' }}>
              <Car size={9} style={{ display: 'inline', marginRight: 4 }} />{plateCount} tracks
            </span>
          </div>
        )}
      </div>

      {/* Vehicle registry per panel */}
      <VehicleRegistry vehicles={vehicles} compact jobId={slot.job_id} plateActions={plateActions} />

      {job?.status === 'error' && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: '#ef4444', display: 'flex', gap: 6, borderTop: '1px solid var(--border-light)' }}>
          <AlertCircle size={12} style={{ flexShrink: 0 }} />{job.message}
        </div>
      )}
    </div>
  );
};

export const VisionFlowMultiCam: React.FC = () => {
  const qc = useQueryClient();
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [sources, setSources] = useState(['dahua-hero-a1', '1', '2', '3']);
  const [busySlots, setBusySlots] = useState<Record<number, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [plateActions, setPlateActions] = useState<Record<string, PlateAction>>({});
  const [syncedCount, setSyncedCount] = useState(0);
  const [syncPolling, setSyncPolling] = useState(false);

  const refreshGrid = useCallback(async () => {
    try {
      const r = await visionflowApi.liveGrid();
      if (!r.ok) return;
      const data: GridResponse = await r.json();
      setGrid(data);
      setSources(prev => {
        const next = [...prev];
        data.slots.forEach(s => {
          if (s.running || !s.source) return;
          const src = s.source.trim();
          if (s.slot === 0 && (src === '0' || src === 'default') && prev[0] === 'dahua-hero-a1') return;
          next[s.slot] = s.source;
        });
        return next;
      });
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    camerasApi.getHeroLiveSource().then(res => {
      if (res.data.token) {
        setSources(prev => {
          const next = [...prev];
          next[0] = res.data.token!;
          return next;
        });
      }
    }).catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    refreshGrid();
    const id = setInterval(refreshGrid, 1200);
    return () => clearInterval(id);
  }, [refreshGrid]);

  const handleToggle = async (slotIndex: number, enable: boolean) => {
    setBusySlots(b => ({ ...b, [slotIndex]: true }));
    try {
        if (enable) {
        const src = sources[slotIndex]?.trim() || (slotIndex === 0 ? 'dahua-hero-a1' : String(slotIndex));
        const r = await visionflowApi.gridStart(slotIndex, src, true, true);
        if (!r.ok) {
          let detail = 'Could not start camera';
          try { const j = await r.json(); if (j.detail) detail = String(j.detail); } catch { /* noop */ }
          setToast(detail);
          setTimeout(() => setToast(null), 4500);
        }
      } else {
        const stoppedJobId = grid?.slots.find(s => s.slot === slotIndex)?.job_id;
        await visionflowApi.gridStop(slotIndex);
        if (stoppedJobId) {
          try { await visionflowSyncApi.syncJob(stoppedJobId); } catch { /* may already be synced */ }
        }
      }
      await refreshGrid();
    } catch {
      setToast('Network error');
      setTimeout(() => setToast(null), 4500);
    } finally {
      setBusySlots(b => ({ ...b, [slotIndex]: false }));
    }
  };

  const active = grid?.active_feeds ?? 0;
  const maxCams = grid?.max_cameras ?? 4;
  const slots = grid?.slots ?? Array.from({ length: maxCams }, (_, i) => ({
    slot: i, source: String(i), label: `Camera ${i + 1}`, enabled: false, running: false,
    job_id: null, session_id: null, camera_available: null, job: null,
  }));

  const allVehicles = useMemo(() => {
    const out: (VehicleRow & { panel: number; panelLabel: string; jobId: string | null })[] = [];
    slots.forEach(s => {
      (s.job?.vehicles ?? []).forEach(v => {
        if (v.plate && v.plate !== '—') {
          out.push({
            ...v,
            panel: s.slot + 1,
            panelLabel: panelTitle(s.slot, sources[s.slot] ?? String(s.slot)),
            jobId: s.job_id,
          });
        }
      });
    });
    return out;
  }, [slots, sources]);

  const activeJobSlots = useMemo(
    () => slots.filter(s => s.running && s.job_id),
    [slots],
  );

  const actionablePlates = useMemo(
    () => Object.values(plateActions).filter(pa => pa.detectionId && pa.state !== 'idle'),
    [plateActions],
  );

  const linkedCount = useMemo(
    () => actionablePlates.filter(pa => pa.vehicle != null).length,
    [actionablePlates],
  );

  useEffect(() => {
    if (activeJobSlots.length === 0) {
      setSyncPolling(false);
      return undefined;
    }

    let cancelled = false;
    setSyncPolling(true);

    const pollAnpr = async () => {
      let totalSynced = 0;
      const merged: Record<string, PlateAction> = {};

      await Promise.all(activeJobSlots.map(async slot => {
        const jid = slot.job_id!;
        const panelLabel = panelTitle(slot.slot, sources[slot.slot] ?? String(slot.slot));
        try {
          const res = await anprApi.byJob(jid);
          const dets: SyncedDetection[] = res.data ?? [];
          totalSynced += dets.length;
          Object.assign(merged, detectionsToPlateActions(dets, jid, panelLabel));
        } catch { /* backend may be loading models */ }
      }));

      if (cancelled) return;

      setPlateActions(prev => {
        const next = { ...prev };
        for (const [key, pa] of Object.entries(merged)) {
          const existing = prev[key];
          if (existing?.state === 'creating') {
            next[key] = existing;
          } else if (existing?.state === 'created') {
            next[key] = { ...pa, state: 'created', linkedVisitId: existing.linkedVisitId ?? pa.linkedVisitId };
          } else {
            next[key] = pa;
          }
        }
        return next;
      });
      setSyncedCount(totalSynced);
      if (totalSynced > 0) {
        qc.invalidateQueries({ queryKey: ['anpr-stats'] });
        qc.invalidateQueries({ queryKey: ['anpr-recent'] });
      }
    };

    pollAnpr();
    const id = setInterval(pollAnpr, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeJobSlots, qc]);

  const handleCreateVisit = useCallback(async (
    pa: PlateAction,
    extra: { owner_name?: string; owner_phone?: string; assigned_bay?: number },
  ) => {
    if (!pa.detectionId) return;
    const key = plateActionKey(pa.jobId, pa.plate);
    setPlateActions(prev => ({ ...prev, [key]: { ...prev[key], state: 'creating' } }));
    try {
      const res = await anprApi.createVisit(pa.detectionId, extra);
      const visitId = res.data.visit_id as number;
      setPlateActions(prev => ({
        ...prev,
        [key]: { ...prev[key], state: 'created', linkedVisitId: visitId },
      }));
      qc.invalidateQueries({ queryKey: ['anpr-stats'] });
      qc.invalidateQueries({ queryKey: ['anpr-recent'] });
      setToast(`Visit opened for ${pa.plate}`);
      setTimeout(() => setToast(null), 3500);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed to create visit';
      setPlateActions(prev => ({ ...prev, [key]: { ...prev[key], state: 'error', error: detail } }));
      setToast(detail);
      setTimeout(() => setToast(null), 4500);
    }
  }, [qc]);

  const pcCamDetected = grid?.probed_cameras?.some(c => c.index === 0);

  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1680, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <Grid2X2 size={22} color="#3b82f6" />
            <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Multi-camera wall</h1>
            <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 10, fontWeight: 700, background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>{active}/{maxCams} LIVE</span>
          </div>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)', maxWidth: 720, lineHeight: 1.65 }}>
            <strong>Panel 1</strong> is your <strong>PC / laptop camera (index 0)</strong> on the machine running the backend.
            Plates sync to the same CarTrack database as <Link to="/visionflow" style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 600 }}>ANPR &amp; Speed</Link> — visible on the{' '}
            <Link to="/" style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 600 }}>Dashboard</Link>, in{' '}
            <Link to="/visits" style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 600 }}>Visits</Link>, and linked to{' '}
            <Link to="/vehicles" style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 600 }}>Vehicles</Link> when tracks exit the frame.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/visionflow" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Gauge size={14} /> Single camera</Link>
          <Link to="/visionflow/history" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><History size={14} /> History</Link>
          <button type="button" className="btn btn-secondary" onClick={() => void refreshGrid()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><RefreshCw size={14} /> Refresh</button>
          {active > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => void visionflowApi.gridStopAll().then(refreshGrid)} style={{ fontSize: 13, color: '#ef4444', display: 'inline-flex', alignItems: 'center', gap: 6 }}><PowerOff size={14} /> Stop all</button>
          )}
        </div>
      </div>

      {/* CarTrack live sync status — same pipeline as ANPR & Speed */}
      {(active > 0 || syncedCount > 0) && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 12,
          background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.22)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)', display: 'grid', placeItems: 'center' }}>
              {syncPolling && syncedCount === 0 ? (
                <Loader2 size={16} color="#06b6d4" style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Link2 size={16} color="#06b6d4" />
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Connected to CarTrack</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {syncedCount > 0
                  ? `${syncedCount} plate read${syncedCount !== 1 ? 's' : ''} in database · ${linkedCount} linked to vehicles`
                  : active > 0
                    ? 'Waiting for plates to exit frame — auto-sync runs on each completed track'
                    : 'Session ended — detections remain in CarTrack'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', fontSize: 12 }}>Dashboard</Link>
            <Link to="/visits" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Clock size={12} /> Visits
            </Link>
            <Link to="/vehicles" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Search size={12} /> Vehicles
            </Link>
          </div>
        </div>
      )}

      {/* Detected cameras banner */}
      {grid?.cameras_busy && (
        <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 10, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', fontSize: 12, color: '#3b82f6' }}>
          Live feeds are running — camera probe paused to avoid locking the webcam. Video preview uses the active job stream.
        </div>
      )}
      <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link2 size={14} /> Cameras detected on server
        </div>
        {grid?.probed_cameras && grid.probed_cameras.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {grid.probed_cameras.map(c => (
              <span key={c.index} style={{
                padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                background: c.index === 0 ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.08)',
                color: c.index === 0 ? '#10b981' : '#3b82f6',
                border: `1px solid ${c.index === 0 ? 'rgba(16,185,129,0.25)' : 'rgba(59,130,246,0.2)'}`,
              }}>
                {c.index === 0 ? '★ PC camera · index 0' : `USB index ${c.index}`}
                {c.in_use ? ' (live)' : c.width ? ` — ${c.width}×${c.height}` : ''}
              </span>
            ))}
          </div>
        ) : grid?.cameras_busy ? (
          <span>Cameras in use by live analysis — if Panel 1 shows black, click <strong>Stop all</strong>, wait 5s, then Start only Panel 1.</span>
        ) : (
          <span>No USB cameras probed yet — use IP/RTSP URLs or connect USB cameras to the server PC.</span>
        )}
        {!pcCamDetected && (
          <div style={{ marginTop: 8, color: '#f59e0b', fontSize: 11 }}>
            Index 0 (PC webcam) not detected right now. Close Zoom/Teams/Camera app and refresh, or use an RTSP URL.
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, marginBottom: 24 }}>
        {slots.map(slot => (
          <CameraTile
            key={slot.slot}
            slot={slot}
            isPcCameraPanel={
              slot.slot === 0
              && ['0', '', 'webcam', 'default', 'local', 'pc'].includes(
                (sources[slot.slot] ?? 'dahua-hero-a1').trim().toLowerCase(),
              )
            }
            sourceDraft={sources[slot.slot] ?? (slot.slot === 0 ? 'dahua-hero-a1' : String(slot.slot))}
            onSourceChange={v => setSources(prev => { const n = [...prev]; n[slot.slot] = v; return n; })}
            onToggle={enable => void handleToggle(slot.slot, enable)}
            busy={Boolean(busySlots[slot.slot])}
            plateActions={plateActions}
          />
        ))}
      </div>

      {/* Combined vehicle registry — all panels */}
      <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border-light)', background: 'var(--bg-surface)' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-elevated)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Car size={16} color="#3b82f6" />
            All cameras — combined vehicle registry
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Same data as ANPR &amp; Speed — plates sync to CarTrack when tracks exit. Open visits or register new vehicles below.
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface)' }}>
                {['Panel', 'Plate', 'OCR', 'Peak km/h', 'Avg km/h', 'Dwell', 'Enter', 'CarTrack', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allVehicles.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>No vehicles tracked yet — start one or more camera feeds above.</td></tr>
              ) : allVehicles.map((v, i) => {
                const pa = v.jobId ? plateActions[plateActionKey(v.jobId, v.plate)] : undefined;
                const linked = pa?.vehicle != null;
                return (
                <tr key={`${v.panel}-${v.track_id}-${i}`} style={{ borderBottom: '1px solid var(--border-light)' }}>
                  <td style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-secondary)' }}>{v.panelLabel}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700, letterSpacing: '0.06em' }}>{v.plate}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <PlateConfidenceCell
                      confidence={v.ocr_confidence}
                      votes={v.ocr_vote_count}
                      segments={v.segment_count}
                    />
                  </td>
                  <td style={{ padding: '10px 12px', color: '#f59e0b', fontWeight: 600 }}>{v.speed_kmh_max ?? '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#3b82f6', fontWeight: 600 }}>{v.speed_kmh_avg ?? '—'}</td>
                  <td style={{ padding: '10px 12px' }}>{v.duration_sec != null ? `${v.duration_sec.toFixed(1)}s` : '—'}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{fmtClock(v.t_enter_sec)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    {pa?.detectionId ? (
                      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 99, background: linked ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.1)', color: linked ? '#10b981' : '#f59e0b', border: `1px solid ${linked ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.2)'}` }}>
                        {linked ? <><Link2 size={8} style={{ display: 'inline', marginRight: 3 }} />linked</> : 'new'}
                      </span>
                    ) : v.status === 'exited' ? (
                      <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />
                    ) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <PlateTrackStatusBadge status={v.status} resumeEligible={v.resume_eligible} />
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </div>

      {/* Plate actions — open visits / register vehicles (same as ANPR & Speed) */}
      {actionablePlates.length > 0 && (
        <div style={{ marginTop: 24, borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle2 size={13} color="#06b6d4" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Plate actions — linked to CarTrack</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  {linkedCount} of {actionablePlates.length} plates found in vehicle database
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
              <PlateActionCard key={plateActionKey(pa.jobId, pa.plate)} pa={pa} />
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 12, background: '#1e293b', color: '#f8fafc', fontSize: 13, zIndex: 9999, maxWidth: 360 }}>{toast}</div>
      )}

      <style>{`@keyframes vfPulse { 0%,100%{opacity:1}50%{opacity:.35} } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};
