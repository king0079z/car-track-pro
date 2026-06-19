import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Webcam, Power, PowerOff, Loader2, Activity, Car,
  RefreshCw, Grid2X2, AlertCircle, Link2, History, Gauge,
  Eye, Monitor, Wifi, Clock, Search, CheckCircle2, Cloud,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Move,
} from 'lucide-react';
import toast from 'react-hot-toast';
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
  ShopDurationCell,
  isRegistryQualityRow,
  isRegistryDisplayRow,
  registryDisplayRows,
  shopPresenceSec,
  type VisionFlowVehicleRow,
} from './VisionFlowPlateQuality';
import { CameraChangeWifiDialog } from '../../components/CameraChangeWifiDialog';

type VehicleRow = VisionFlowVehicleRow;

interface LiveHealth {
  stream_connected?: boolean;
  processed_frames?: number;
  message?: string;
  last_frame_at?: string | null;
  idle?: boolean;
  stream_tier?: 'sd' | 'hd' | null;
  anpr?: {
    boxes?: number;
    tracks_locked?: number;
    tracks_searching?: number;
    searching?: boolean;
    multi_car?: boolean;
    detect_mode?: string;
  };
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
  camera_id?: string | null;
  ptz_supported?: boolean;
  wifi_supported?: boolean;
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
  if (slot === 0 && isDahua) return 'Panel 1 — DH-H3A (Cloud / Easy4IP)';
  if (slot === 0 && (!s || s === '0' || s === 'webcam')) return 'Panel 1 — PC / laptop camera';
  return `Panel ${slot + 1} — USB camera #${slot}`;
}

function panelSubtitle(slot: number, source: string): string {
  const s = source.trim();
  if (s === 'dahua-hero-a1' || s === 'dahua' || s === 'hero-a1') {
    return 'Source: DH-H3A via Cloud (Easy4IP P2P relay) — configured in Settings';
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
  { value: 'dahua-hero-a1', label: 'DH-H3A (Cloud / Easy4IP)', icon: Cloud, hint: 'Saved Hero A1 — connects via Dahua cloud (Easy4IP P2P), no LAN needed' },
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
  const rows = registryDisplayRows(vehicles);
  const verified = rows.filter(isRegistryQualityRow);
  const scanning = rows.length - verified.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: compact ? undefined : 1 }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-elevated)' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Eye size={11} /> Vehicle registry
        </span>
        {rows.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 7px', borderRadius: 99, border: '1px solid var(--border-light)' }}>
            {verified.length} verified{scanning > 0 ? ` · ${scanning} scanning` : ''}
          </span>
        )}
      </div>
      <div className="table-scroll" style={{ overflowY: 'auto', maxHeight: compact ? 140 : 220 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface)' }}>
              {['#', 'Plate', 'OCR', 'Peak', 'Avg', 'Dwell', 'Duration', 'CarTrack', 'Status'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '16px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                  Waiting for tracked vehicles…
                </td>
              </tr>
            ) : rows.map((v, i) => {
              const verifiedRow = isRegistryQualityRow(v);
              const pa = jobId && plateActions ? plateActions[plateActionKey(jobId, v.plate)] : undefined;
              const linked = pa?.vehicle != null;
              return (
              <tr key={`${v.plate}-${i}`} style={{ borderBottom: '1px solid var(--border-light)', opacity: verifiedRow ? 1 : 0.85 }}>
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
                  <ShopDurationCell
                    sec={shopPresenceSec(v)}
                    active={v.status === 'active'}
                    paused={Boolean(v.resume_eligible)}
                    compact
                  />
                </td>
                <td style={{ padding: '6px 8px' }}>
                  {pa ? (
                    <span style={{
                      fontSize: 8, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 99,
                      background: linked ? 'rgba(16,185,129,0.12)' : verifiedRow ? 'rgba(245,158,11,0.1)' : 'rgba(148,163,184,0.12)',
                      color: linked ? '#10b981' : verifiedRow ? '#f59e0b' : '#94a3b8',
                      border: `1px solid ${linked ? 'rgba(16,185,129,0.25)' : verifiedRow ? 'rgba(245,158,11,0.2)' : 'rgba(148,163,184,0.2)'}`,
                    }}>
                      {linked ? 'linked' : verifiedRow ? (pa.detectionId ? 'synced' : '…') : v.phase === 'reacquiring' ? 're-search' : 'scanning'}
                    </span>
                  ) : verifiedRow ? '…' : 'scanning'}
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

/** Cloud/LAN pan-tilt-zoom pad overlaid on a live PTZ-capable camera. */
const PtzControl: React.FC<{ cameraId: string }> = ({ cameraId }) => {
  const [busyDir, setBusyDir] = useState<string | null>(null);

  const nudge = useCallback(async (direction: string) => {
    setBusyDir(direction);
    try {
      const { data } = await camerasApi.ptz(cameraId, direction, 1);
      if (!data.ok) toast.error(data.error || 'PTZ command failed', { duration: 5000 });
    } catch {
      toast.error('PTZ command failed');
    } finally {
      setBusyDir(null);
    }
  }, [cameraId]);

  const btn = (direction: string, icon: React.ReactNode, title: string): React.ReactNode => (
    <button
      type="button"
      title={title}
      disabled={busyDir !== null}
      onClick={() => void nudge(direction)}
      style={{
        width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center',
        border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(8,12,20,0.66)',
        color: busyDir === direction ? '#3b82f6' : '#e5e7eb',
        cursor: busyDir !== null ? 'wait' : 'pointer', backdropFilter: 'blur(3px)',
      }}
    >
      {busyDir === direction ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : icon}
    </button>
  );

  return (
    <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 99, background: 'rgba(8,12,20,0.66)', color: '#cbd5e1', fontSize: 9, fontWeight: 700, backdropFilter: 'blur(3px)' }}>
        <Move size={10} /> PTZ
      </div>
      {btn('up', <ChevronUp size={16} />, 'Tilt up')}
      <div style={{ display: 'flex', gap: 4 }}>
        {btn('left', <ChevronLeft size={16} />, 'Pan left')}
        {btn('right', <ChevronRight size={16} />, 'Pan right')}
      </div>
      {btn('down', <ChevronDown size={16} />, 'Tilt down')}
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {btn('zoom_in', <ZoomIn size={15} />, 'Zoom in')}
        {btn('zoom_out', <ZoomOut size={15} />, 'Zoom out')}
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
  hideSourceConfig?: boolean;
  hideRegistry?: boolean;
  embedMode?: boolean;
}> = ({ slot, sourceDraft, onSourceChange, onToggle, busy, isPcCameraPanel, plateActions, hideSourceConfig, hideRegistry, embedMode }) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [showIpHint, setShowIpHint] = useState(false);
  const prevUrl = useRef<string | null>(null);
  const activeRef = useRef(true);
  const standbyRef = useRef(false);
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
  const standby = Boolean(running && health?.idle);
  standbyRef.current = standby;
  const streamOk = Boolean(running && health?.stream_connected && health?.last_frame_at && !standby);
  const plateCount = vehicles.filter(v => v.plate && v.plate !== '—' && v.plate !== '…').length;
  const trackCount = vehicles.filter(v => v.track_id != null && v.track_id >= 0).length;
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
          // Standby (power save): the frame barely changes — poll gently. The
          // fetch itself signals "someone is watching" and wakes the stream.
          delay = standbyRef.current ? 1500 : 120;
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
      borderRadius: embedMode ? 0 : 16,
      overflow: 'hidden',
      border: embedMode ? 'none' : `1px solid ${isPcCameraPanel ? 'rgba(16,185,129,0.35)' : running ? 'rgba(59,130,246,0.35)' : 'var(--border-light)'}`,
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', minHeight: 0,
      boxShadow: embedMode ? undefined : (isPcCameraPanel && !running ? '0 0 0 1px rgba(16,185,129,0.08)' : undefined),
    }}>
      {/* Header */}
      <div style={{ padding: embedMode ? '8px 10px' : '10px 14px', borderBottom: '1px solid var(--border-light)', background: isPcCameraPanel ? 'rgba(16,185,129,0.06)' : 'var(--bg-elevated)' }}>
        <div className="camera-tile-header">
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: running ? 'rgba(16,185,129,0.15)' : isPcCameraPanel ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
            border: `1px solid ${running || isPcCameraPanel ? 'rgba(16,185,129,0.3)' : 'var(--border-light)'}`,
            display: 'grid', placeItems: 'center',
          }}>
            {isPcCameraPanel ? <Monitor size={15} color="#10b981" /> : <Webcam size={15} color={running ? '#10b981' : '#64748b'} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={panelTitle(slot.slot, sourceDraft)}>
                {panelTitle(slot.slot, sourceDraft)}
              </span>
              {isPcCameraPanel && (
                <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.25)' }}>
                  INDEX 0
                </span>
              )}
              {slot.camera_available === true && (
                <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(59,130,246,0.1)', color: '#3b82f6' }}>DETECTED</span>
              )}
            </div>
            {!embedMode && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{panelSubtitle(slot.slot, sourceDraft)}</div>
            )}
          </div>
          <div className="camera-tile-actions">
            {streamOk && (
              <span style={{ fontSize: 10, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'vfPulse 1s ease-in-out infinite' }} /> LIVE
                {health?.stream_tier && (
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 5, background: health.stream_tier === 'hd' ? 'rgba(59,130,246,0.15)' : 'rgba(100,116,139,0.15)', color: health.stream_tier === 'hd' ? '#3b82f6' : '#94a3b8' }}>
                    {health.stream_tier.toUpperCase()}
                  </span>
                )}
              </span>
            )}
            {standby && (
              <span
                title="Power save — no vehicles detected. The camera wakes instantly on motion or when you watch this feed."
                style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', animation: 'vfPulse 2.4s ease-in-out infinite' }} /> STANDBY
              </span>
            )}
            {(slot.wifi_supported || slot.camera_id === 'hero-a1' || (slot.source || '').includes('dahua')) && slot.camera_id && (
              <button type="button" onClick={() => setWifiOpen(true)} title="Change camera Wi-Fi" style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                border: '1px solid var(--border-light)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}>
                <Wifi size={13} />
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => onToggle(!locked)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none', flexShrink: 0,
              cursor: busy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 700,
              background: locked ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.15)',
              color: locked ? '#ef4444' : '#10b981', opacity: busy ? 0.6 : 1,
            }}>
              {busy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : locked ? <PowerOff size={12} /> : <Power size={12} />}
              {locked ? 'Stop' : 'Start'}
            </button>
          </div>
        </div>
      </div>

      {!hideSourceConfig && (
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
      )}

      {/* Preview */}
      <div style={{
        position: 'relative',
        aspectRatio: '16/9',
        maxHeight: embedMode ? 200 : undefined,
        background: '#030407',
        flexShrink: 0,
      }}>
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
        {standby && preview && (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: 'rgba(3,4,7,0.55)', backdropFilter: 'blur(1px)', textAlign: 'center', padding: 16,
          }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', marginBottom: 4 }}>Power save</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                No vehicles in view — wakes instantly on motion or while you watch
              </div>
            </div>
          </div>
        )}
        {running && slot.ptz_supported && slot.camera_id && (
          <PtzControl cameraId={slot.camera_id} />
        )}
        {running && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6 }}>
            <span style={{ padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,0,0,0.65)', color: 'var(--text-accent)' }}>
              <Activity size={9} style={{ display: 'inline', marginRight: 4 }} />{job?.processed_frames ?? 0} frames
            </span>
            <span style={{ padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,0,0,0.65)', color: 'var(--text-success)' }}>
              <Car size={9} style={{ display: 'inline', marginRight: 4 }} />{trackCount > 0 ? `${plateCount || 0} plate${plateCount !== 1 ? 's' : ''} · ${trackCount} track${trackCount !== 1 ? 's' : ''}` : `${job?.processed_frames ?? 0} AI frames`}
            </span>
          </div>
        )}
      </div>

      {!hideRegistry && (
      <VehicleRegistry vehicles={vehicles} compact jobId={slot.job_id} plateActions={plateActions} />
      )}

      {job?.status === 'error' && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: '#ef4444', display: 'flex', gap: 6, borderTop: '1px solid var(--border-light)' }}>
          <AlertCircle size={12} style={{ flexShrink: 0 }} />{job.message}
        </div>
      )}

      {wifiOpen && slot.camera_id && (
        <CameraChangeWifiDialog
          cameraId={slot.camera_id}
          cameraName={panelTitle(slot.slot, sourceDraft)}
          isOpen={wifiOpen}
          onClose={() => setWifiOpen(false)}
        />
      )}
    </div>
  );
};

export const VisionFlowMultiCam: React.FC = () => {
  const qc = useQueryClient();
  const location = useLocation();
  const cloudWelcomeShown = useRef(false);
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

  const anySearching = useMemo(
    () => grid?.slots.some(s => s.job?.live_health?.anpr?.searching) ?? false,
    [grid],
  );

  useEffect(() => {
    refreshGrid();
    // Faster registry sync while plates are being re-acquired after a camera move.
    const ms = anySearching ? 900 : 1800;
    const id = setInterval(refreshGrid, ms);
    return () => clearInterval(id);
  }, [refreshGrid, anySearching]);

  useEffect(() => {
    const st = location.state as { fromCloudConnect?: boolean; liveStarted?: boolean } | null;
    if (!st?.fromCloudConnect || cloudWelcomeShown.current) return;
    cloudWelcomeShown.current = true;
    setToast(st.liveStarted ? 'Camera connected — live feed is starting (models may take 30–90s on first run)' : 'Camera connected');
    setTimeout(() => setToast(null), 6000);
    window.history.replaceState({}, document.title);
  }, [location.state]);

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
    const raw: (VehicleRow & { panel: number; panelLabel: string; jobId: string | null })[] = [];
    slots.forEach(s => {
      (s.job?.vehicles ?? []).forEach(v => {
        if (isRegistryDisplayRow(v)) {
          raw.push({
            ...v,
            panel: s.slot + 1,
            panelLabel: panelTitle(s.slot, sources[s.slot] ?? String(s.slot)),
            jobId: s.job_id,
          });
        }
      });
    });
    const byPlate = new Map<string, VehicleRow & { panel: number; panelLabel: string; jobId: string | null; panels: string[] }>();
    for (const v of raw) {
      const key = v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const prev = byPlate.get(key);
      if (!prev) {
        byPlate.set(key, { ...v, panels: [v.panelLabel] });
        continue;
      }
      const pick = v.status === 'active' ? v : prev.status === 'active' ? prev : v;
      byPlate.set(key, {
        ...pick,
        panels: [...new Set([...prev.panels, v.panelLabel])],
        duration_sec: Math.max(prev.duration_sec ?? 0, v.duration_sec ?? 0),
        presence_duration_sec: Math.max(prev.presence_duration_sec ?? 0, v.presence_duration_sec ?? 0),
        ocr_confidence: Math.max(prev.ocr_confidence ?? 0, v.ocr_confidence ?? 0),
        ocr_vote_count: Math.max(prev.ocr_vote_count ?? 0, v.ocr_vote_count ?? 0),
        status: v.status === 'active' || prev.status === 'active' ? 'active' : pick.status,
        resume_eligible: v.resume_eligible || prev.resume_eligible,
        jobId: pick.jobId ?? v.jobId,
        panel: pick.panel,
      });
    }
    return [...byPlate.values()].map(v => ({
      ...v,
      panelLabel: v.panels.join(' · '),
    }));
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
  }, [activeJobSlots, qc, sources]);

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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            slots.length <= 2
              ? 'repeat(auto-fit, minmax(0, 1fr))'
              : 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
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
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface)' }}>
                {['Panel', 'Plate', 'OCR', 'Peak km/h', 'Avg km/h', 'Dwell', 'Duration', 'Enter', 'CarTrack', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allVehicles.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>No vehicles tracked yet — start one or more camera feeds above.</td></tr>
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
                  <td style={{ padding: '10px 12px' }}>
                    <ShopDurationCell
                      sec={shopPresenceSec(v)}
                      active={v.status === 'active'}
                      paused={Boolean(v.resume_eligible)}
                    />
                  </td>
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

/** Compact live feed for dashboard embed — no source picker UI. */
export const LiveCameraEmbedPanel: React.FC<{ slot?: number; hideRegistry?: boolean }> = ({
  slot = 0,
  hideRegistry = true,
}) => {
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [source, setSource] = useState('dahua-hero-a1');
  const [busy, setBusy] = useState(false);

  const refreshGrid = useCallback(async () => {
    try {
      const r = await visionflowApi.liveGrid();
      if (r.ok) setGrid(await r.json());
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    camerasApi.getHeroLiveSource().then(res => {
      if (res.data.token) setSource(res.data.token);
    }).catch(() => { /* keep default */ });
  }, []);

  useEffect(() => {
    refreshGrid();
    const id = setInterval(refreshGrid, 2000);
    return () => clearInterval(id);
  }, [refreshGrid]);

  const handleToggle = async (enable: boolean) => {
    setBusy(true);
    try {
      if (enable) {
        const src = source.trim() || 'dahua-hero-a1';
        const r = await visionflowApi.gridStart(slot, src, true, true);
        if (!r.ok) {
          let detail = 'Could not start camera';
          try { const j = await r.json(); if (j.detail) detail = String(j.detail); } catch { /* noop */ }
          toast.error(detail, { duration: 5000 });
        }
      } else {
        await visionflowApi.gridStop(slot);
      }
      await refreshGrid();
    } catch {
      toast.error('Camera network error');
    } finally {
      setBusy(false);
    }
  };

  const slots = grid?.slots ?? [];
  const slotData: GridSlot = slots.find(s => s.slot === slot) ?? {
    slot,
    source,
    label: `Camera ${slot + 1}`,
    enabled: false,
    running: false,
    job_id: null,
    session_id: null,
    camera_available: null,
    job: null,
  };

  const isPc = slot === 0 && ['0', '', 'webcam', 'default', 'local', 'pc'].includes(source.trim().toLowerCase());

  return (
    <CameraTile
      slot={slotData}
      sourceDraft={source}
      onSourceChange={setSource}
      onToggle={enable => void handleToggle(enable)}
      busy={busy}
      isPcCameraPanel={isPc}
      hideSourceConfig
      hideRegistry={hideRegistry}
      embedMode
    />
  );
};
