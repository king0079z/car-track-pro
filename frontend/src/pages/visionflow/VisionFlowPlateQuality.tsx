import React from 'react';

export interface VisionFlowVehicleRow {
  track_id: number | null;
  plate: string;
  speed_kmh_max: number | null;
  speed_kmh_avg: number | null;
  speed_kmh_last: number | null;
  t_enter_sec: number | null;
  t_exit_sec: number | null;
  duration_sec: number | null;
  /** Shop/service presence — counts while Live, pauses when Paused, locks on Done */
  presence_duration_sec?: number | null;
  status: 'active' | 'exited';
  first_frame?: number;
  last_frame?: number;
  ocr_confidence?: number | null;
  ocr_vote_count?: number | null;
  segment_count?: number | null;
  resume_eligible?: boolean;
  /** Live-only: OCR confirmed for this track */
  ocr_locked?: boolean;
  /** Live-only: searching | locked | reacquiring */
  phase?: 'searching' | 'locked' | 'reacquiring';
  visible_in_frame?: boolean;
}

export function confidenceColor(confidence: number): string {
  const pct = confidence * 100;
  if (pct >= 70) return '#10b981';
  if (pct >= 45) return '#f59e0b';
  return '#ef4444';
}

/** Qatar-shaped plate string (for showing scanning rows). */
export function isPlausiblePlateRow(v: VisionFlowVehicleRow): boolean {
  const plate = (v.plate || '').trim();
  if (!plate || plate === '—' || plate === '…') return false;
  const key = plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (key.length < 4) return false;
  const digits = (key.match(/\d/g) || []).length;
  const letters = (key.match(/[A-Z]/g) || []).length;
  return (/^\d{4,6}$/.test(key)) || (/^\d{3,6}Q$/.test(key)) || (digits >= 3 && letters >= 2);
}

/** Registry rows — confirmed plates only (no Unknown / ghost tracks). */
export function isRegistryDisplayRow(v: VisionFlowVehicleRow): boolean {
  const plate = (v.plate || '').trim().toUpperCase();
  if (!plate || plate === '—' || plate === '…' || plate === 'UNKNOWN') return false;
  if (!isPlausiblePlateRow(v)) return false;
  // Active tracks still searching — hide until OCR confirms.
  if (v.status === 'active' && v.ocr_locked === false) return false;
  return true;
}

/** Merge by plate but keep distinct vehicles when track IDs differ and both are visible history. */
export function mergeVehicleRowsByPlate(rows: VisionFlowVehicleRow[]): VisionFlowVehicleRow[] {
  const merged = new Map<string, VisionFlowVehicleRow>();
  for (const v of rows) {
    if (!isPlausiblePlateRow(v)) continue;
    const key = v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...v });
      continue;
    }
    const active = v.status === 'active' || prev.status === 'active';
    merged.set(key, {
      ...(active && v.status === 'active' ? v : prev),
      ocr_vote_count: Math.max(prev.ocr_vote_count ?? 0, v.ocr_vote_count ?? 0),
      duration_sec: Math.max(prev.duration_sec ?? 0, v.duration_sec ?? 0),
      presence_duration_sec: Math.max(prev.presence_duration_sec ?? 0, v.presence_duration_sec ?? 0),
      ocr_confidence: Math.max(prev.ocr_confidence ?? 0, v.ocr_confidence ?? 0),
      segment_count: Math.max(prev.segment_count ?? 1, v.segment_count ?? 1),
      status: active ? 'active' : (v.status === 'exited' ? 'exited' : prev.status),
      resume_eligible: v.resume_eligible || prev.resume_eligible,
      ocr_locked: prev.ocr_locked !== false || v.ocr_locked !== false,
    });
  }
  return [...merged.values()];
}

/** Rows ready for CarTrack sync (matches backend manifest_sync_quality_ok). */
export function isRegistryQualityRow(v: VisionFlowVehicleRow): boolean {
  if (!isPlausiblePlateRow(v)) return false;
  const votes = v.ocr_vote_count ?? 0;
  const conf = v.ocr_confidence ?? 0;
  const dwell = v.duration_sec ?? 0;
  const key = v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const commercial = /^\d{4,6}$/.test(key);
  if (votes >= 2 && dwell >= 0.8) return true;
  if (commercial && votes >= 1 && conf >= 0.88 && dwell >= 1.2) return true;
  if (votes >= 1 && conf >= 0.88 && dwell >= 1.5) return true;
  if (votes >= 3 && dwell >= 0.5) return true;
  return false;
}

export function registryDisplayRows(rows: VisionFlowVehicleRow[]): VisionFlowVehicleRow[] {
  const filtered = rows.filter(isRegistryDisplayRow);
  const merged = mergeVehicleRowsByPlate(filtered);
  return merged.sort((a, b) => (a.t_enter_sec ?? 0) - (b.t_enter_sec ?? 0));
}

export function fmtShopDuration(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function shopPresenceSec(v: VisionFlowVehicleRow): number | null {
  if (v.presence_duration_sec != null) return v.presence_duration_sec;
  if (v.duration_sec != null) return v.duration_sec;
  return null;
}

export const ShopDurationCell: React.FC<{
  sec?: number | null;
  active?: boolean;
  paused?: boolean;
  compact?: boolean;
}> = ({ sec, active, paused, compact }) => {
  const label = fmtShopDuration(sec);
  const color = active ? '#3b82f6' : paused ? '#f59e0b' : 'var(--text-secondary)';
  return (
    <span
      title={
        active
          ? 'Shop presence — counting while vehicle is Live in view'
          : paused
            ? 'Shop presence — paused while vehicle is off camera (within resume window)'
            : 'Final shop presence for this visit'
      }
      style={{
        fontVariantNumeric: 'tabular-nums',
        fontWeight: active ? 700 : 600,
        color,
        fontSize: compact ? 11 : 12,
      }}
    >
      {label}
    </span>
  );
};

export function fmtConfPct(confidence: number | null | undefined): string {
  if (confidence == null || Number.isNaN(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

export const PlateConfidenceCell: React.FC<{
  confidence?: number | null;
  votes?: number | null;
  segments?: number | null;
  compact?: boolean;
}> = ({ confidence, votes, segments, compact }) => {
  const voteN = votes ?? 0;
  const segN = segments ?? 1;
  if (confidence == null && voteN === 0) {
    return <span style={{ color: 'var(--text-muted)', fontSize: compact ? 10 : 11 }}>—</span>;
  }
  const color = confidence != null ? confidenceColor(confidence) : 'var(--text-muted)';
  const barW = confidence != null ? Math.max(8, Math.round(confidence * 100)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 3, minWidth: compact ? 52 : 64 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: compact ? 10 : 11, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
          {fmtConfPct(confidence)}
        </span>
        {confidence != null && (
          <div style={{ flex: 1, height: 4, borderRadius: 99, background: 'var(--border-light)', overflow: 'hidden', minWidth: 28 }}>
            <div style={{ width: `${barW}%`, height: '100%', background: color, borderRadius: 99, transition: 'width 0.25s ease' }} />
          </div>
        )}
      </div>
      <span style={{ fontSize: compact ? 9 : 9.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {voteN} vote{voteN !== 1 ? 's' : ''}
        {segN > 1 ? ` · ${segN} seg` : ''}
      </span>
    </div>
  );
};

export const PlateTrackStatusBadge: React.FC<{
  status: 'active' | 'exited';
  resumeEligible?: boolean;
  compact?: boolean;
}> = ({ status, resumeEligible, compact }) => {
  if (status === 'active') {
    return (
      <span
        title="Vehicle currently in camera view"
        style={{
          fontSize: compact ? 9 : 9.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          padding: compact ? '2px 6px' : '2px 8px',
          borderRadius: 99,
          background: 'rgba(59,130,246,0.12)',
          color: '#3b82f6',
          border: '1px solid rgba(59,130,246,0.25)',
          whiteSpace: 'nowrap',
        }}
      >
        Live
      </span>
    );
  }
  if (resumeEligible) {
    return (
      <span
        title="Left camera view (e.g. moved to another bay) — keeps waiting; resumes the in-shop timer if the same plate returns within the configured waiting period, otherwise becomes Done"
        style={{
          fontSize: compact ? 9 : 9.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          padding: compact ? '2px 6px' : '2px 8px',
          borderRadius: 99,
          background: 'rgba(245,158,11,0.12)',
          color: '#f59e0b',
          border: '1px solid rgba(245,158,11,0.28)',
          whiteSpace: 'nowrap',
        }}
      >
        Paused
      </span>
    );
  }
  return (
    <span
      title="Track exited camera view"
      style={{
        fontSize: compact ? 9 : 9.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        padding: compact ? '2px 6px' : '2px 8px',
        borderRadius: 99,
        background: 'rgba(16,185,129,0.12)',
        color: '#10b981',
        border: '1px solid rgba(16,185,129,0.25)',
        whiteSpace: 'nowrap',
      }}
    >
      Done
    </span>
  );
};
