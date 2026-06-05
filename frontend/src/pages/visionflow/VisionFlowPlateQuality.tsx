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
  status: 'active' | 'exited';
  first_frame?: number;
  last_frame?: number;
  ocr_confidence?: number | null;
  ocr_vote_count?: number | null;
  segment_count?: number | null;
  resume_eligible?: boolean;
}

export function confidenceColor(confidence: number): string {
  const pct = confidence * 100;
  if (pct >= 70) return '#10b981';
  if (pct >= 45) return '#f59e0b';
  return '#ef4444';
}

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
        title="Left frame — will resume Live if same plate returns within 2 hours"
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
