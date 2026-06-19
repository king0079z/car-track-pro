import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ScanLine, ArrowRight, Link2, Plus, Car, ChevronDown, ChevronRight,
  Grid2X2, Gauge, Clock, Video, ExternalLink, Radio,
} from 'lucide-react';
import { anprApi, visionflowApi } from '../../services/api';
import { fmtQatarEntryHm } from '../../lib/qatarTime';
import { fmtShopDuration } from '../../pages/visionflow/VisionFlowPlateQuality';

interface AnprSegment {
  id: number;
  plate: string;
  speed_kmh?: number | null;
  duration_sec?: number | null;
  presence_duration_sec?: number | null;
  job_id?: string | null;
  video_name?: string | null;
  camera_name?: string | null;
  camera_slot?: number | null;
  detected_at?: string | null;
  track_id?: number | null;
  visit_id?: number | null;
  vehicle?: {
    id: number;
    plate_number?: string;
    make?: string;
    model?: string;
    owner_name?: string;
    total_visits?: number;
  } | null;
}

interface AnprPlateGroup {
  plate: string;
  segment_count: number;
  total_presence_sec: number;
  total_duration_sec: number;
  latest_at?: string | null;
  latest_job_id?: string | null;
  camera_name?: string | null;
  camera_slot?: number | null;
  max_speed_kmh?: number | null;
  vehicle?: AnprSegment['vehicle'];
  visit_id?: number | null;
  segments: AnprSegment[];
}

interface LiveGridSlot {
  slot: number;
  running?: boolean;
  job_id?: string | null;
  label?: string;
}

function segmentDuration(seg: AnprSegment): number {
  if (seg.presence_duration_sec != null) return seg.presence_duration_sec;
  if (seg.duration_sec != null) return seg.duration_sec;
  return 0;
}

function cameraLabel(group: AnprPlateGroup, liveJobIds: Set<string>): string {
  if (group.camera_name) return group.camera_name;
  if (group.camera_slot != null) return `Camera ${group.camera_slot + 1}`;
  if (group.latest_job_id && liveJobIds.has(group.latest_job_id)) return 'Live feed';
  if (group.latest_job_id) return 'VisionFlow';
  return '—';
}

const PlateRow: React.FC<{
  group: AnprPlateGroup;
  expanded: boolean;
  onToggle: () => void;
  liveJobIds: Set<string>;
}> = ({ group, expanded, onToggle, liveJobIds }) => {
  const isLive = Boolean(group.latest_job_id && liveJobIds.has(group.latest_job_id));
  const vehicle = group.vehicle;

  return (
    <div className={`anpr-dash-plate${expanded ? ' is-expanded' : ''}`}>
      <button type="button" className="anpr-dash-plate-head" onClick={onToggle}>
        <span className="anpr-dash-plate-chevron">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="anpr-dash-plate-num">{group.plate}</span>
        {isLive && (
          <span className="anpr-dash-live-pill">
            <Radio size={10} /> Live
          </span>
        )}
        <span className="anpr-dash-plate-duration" title="Shop presence duration">
          <Clock size={12} />
          {fmtShopDuration(group.total_presence_sec || group.total_duration_sec)}
        </span>
        <span className="anpr-dash-plate-meta">
          {group.segment_count} seg · {cameraLabel(group, liveJobIds)}
        </span>
        <span className="anpr-dash-plate-speed">
          {group.max_speed_kmh != null ? `${Math.round(group.max_speed_kmh)} km/h` : '—'}
        </span>
        <span className="anpr-dash-plate-vehicle">
          {vehicle ? (
            <>
              <Link2 size={12} />
              {[vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.plate_number}
            </>
          ) : (
            <span className="anpr-dash-muted">Not registered</span>
          )}
        </span>
        <span className="anpr-dash-plate-time">
          {group.latest_at ? fmtQatarEntryHm(group.latest_at) : '—'}
        </span>
      </button>

      {expanded && (
        <div className="anpr-dash-segments">
          <div className="anpr-dash-segments-head">
            <span>Segment history ({group.segment_count})</span>
            <div className="anpr-dash-segments-links">
              <Link to="/visionflow/multicam" className="anpr-dash-link">
                <Grid2X2 size={12} /> Camera wall
              </Link>
              <Link to="/visionflow" className="anpr-dash-link">
                <Gauge size={12} /> ANPR &amp; Speed
              </Link>
              <Link to="/visionflow/history" className="anpr-dash-link">
                <Video size={12} /> History
              </Link>
            </div>
          </div>
          <table className="anpr-dash-seg-table">
            <thead>
              <tr>
                {['When', 'Duration', 'Dwell', 'Speed', 'Camera', 'Track', 'Job', ''].map(h => (
                  <th key={h || 'act'}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.segments.map(seg => {
                const segLive = Boolean(seg.job_id && liveJobIds.has(seg.job_id));
                return (
                  <tr key={seg.id}>
                    <td>{seg.detected_at ? fmtQatarEntryHm(seg.detected_at) : '—'}</td>
                    <td className="anpr-dash-duration-cell">
                      {fmtShopDuration(segmentDuration(seg))}
                    </td>
                    <td>{seg.duration_sec != null ? `${seg.duration_sec.toFixed(1)}s` : '—'}</td>
                    <td>{seg.speed_kmh != null ? `${seg.speed_kmh} km/h` : '—'}</td>
                    <td>
                      {seg.camera_name || (seg.camera_slot != null ? `Cam ${seg.camera_slot + 1}` : '—')}
                      {segLive && <span className="anpr-dash-live-dot" title="Live job" />}
                    </td>
                    <td>{seg.track_id ?? '—'}</td>
                    <td>
                      {seg.job_id ? (
                        <span className="anpr-dash-job-id" title={seg.job_id}>
                          {seg.job_id.slice(0, 8)}…
                        </span>
                      ) : '—'}
                    </td>
                    <td className="anpr-dash-seg-actions">
                      {seg.visit_id ? (
                        <Link to={`/visits/${seg.visit_id}`} className="anpr-dash-link-sm">Visit</Link>
                      ) : (
                        <Link
                          to={`/visits/new?plate=${encodeURIComponent(seg.plate)}`}
                          className="anpr-dash-link-sm primary"
                        >
                          <Plus size={10} /> WO
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="anpr-dash-plate-actions">
            {vehicle && (
              <Link to={`/vehicles/${vehicle.id}`} className="btn btn-ghost btn-sm">
                <Car size={12} /> Vehicle profile
              </Link>
            )}
            {group.visit_id && (
              <Link to={`/visits/${group.visit_id}`} className="btn btn-ghost btn-sm">
                <ExternalLink size={12} /> Open visit
              </Link>
            )}
            <Link
              to={`/visits/new?plate=${encodeURIComponent(group.plate)}`}
              className="btn btn-secondary btn-sm"
            >
              <Plus size={12} /> New work order
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export const AnprDashboardWidget: React.FC = () => {
  const [expandedPlates, setExpandedPlates] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const previewCount = 8;

  const { data: statsRes } = useQuery({
    queryKey: ['anpr-stats'],
    queryFn: () => anprApi.stats(),
    refetchInterval: 30000,
  });

  const { data: summaryRes, isLoading } = useQuery({
    queryKey: ['anpr-summary'],
    queryFn: () => anprApi.summary(100, 7),
    refetchInterval: 20000,
  });

  const { data: liveJobIds = new Set<string>() } = useQuery({
    queryKey: ['vf-live-job-ids'],
    queryFn: async () => {
      try {
        const r = await visionflowApi.liveGrid();
        if (!r.ok) return new Set<string>();
        const data = await r.json();
        const ids = new Set<string>();
        for (const s of (data.slots ?? []) as LiveGridSlot[]) {
          if (s.running && s.job_id) ids.add(s.job_id);
        }
        return ids;
      } catch {
        return new Set<string>();
      }
    },
    refetchInterval: 15000,
  });

  const stats = statsRes?.data;
  const summary = summaryRes?.data as {
    total_plates?: number;
    total_segments?: number;
    plates?: AnprPlateGroup[];
  } | undefined;
  const allPlates: AnprPlateGroup[] = summary?.plates ?? [];
  const totalPlates = summary?.total_plates ?? allPlates.length;
  const totalSegments = summary?.total_segments ?? 0;
  const liveCount = liveJobIds.size;

  const visiblePlates = useMemo(
    () => (showAll ? allPlates : allPlates.slice(0, previewCount)),
    [allPlates, showAll],
  );

  const togglePlate = (plate: string) => {
    setExpandedPlates(prev => {
      const next = new Set(prev);
      if (next.has(plate)) next.delete(plate);
      else next.add(plate);
      return next;
    });
  };

  if (!stats && !allPlates.length && !isLoading) return null;

  return (
    <div className="anpr-dash-card">
      <div className="anpr-dash-header">
        <div className="anpr-dash-header-left">
          <div className="anpr-dash-icon">
            <ScanLine size={18} />
          </div>
          <div>
            <h2 className="anpr-dash-title">ANPR detections</h2>
            <p className="anpr-dash-subtitle">
              Shop duration &amp; plate history · synced from Camera wall &amp; ANPR &amp; Speed
              {liveCount > 0 && (
                <span className="anpr-dash-live-count">
                  · {liveCount} live feed{liveCount !== 1 ? 's' : ''}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="anpr-dash-header-actions">
          <Link to="/visionflow/multicam" className="btn btn-ghost btn-sm anpr-dash-nav-btn">
            <Grid2X2 size={13} /> Camera wall
          </Link>
          <Link to="/visionflow" className="btn btn-secondary btn-sm anpr-dash-nav-btn">
            <Gauge size={13} /> ANPR &amp; Speed <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {stats && (
        <div className="anpr-dash-stats">
          {[
            { label: 'Today', value: stats.today_detections ?? 0, color: '#06b6d4' },
            { label: 'Unique plates', value: stats.today_unique_plates ?? 0, color: '#3b82f6' },
            { label: 'This week', value: stats.week_detections ?? 0, color: '#8b5cf6' },
            { label: 'Avg speed', value: stats.avg_speed_kmh ? `${stats.avg_speed_kmh}` : '—', color: '#d97706', suffix: stats.avg_speed_kmh ? ' km/h' : '' },
            { label: 'Linked', value: stats.linked_to_vehicle ?? 0, color: '#059669' },
            { label: 'Plates (7d)', value: totalPlates, color: '#0ea5e9' },
          ].map(s => (
            <div key={s.label} className="anpr-dash-stat">
              <div className="anpr-dash-stat-value" style={{ color: s.color }}>
                {s.value}{s.suffix ?? ''}
              </div>
              <div className="anpr-dash-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {isLoading && allPlates.length === 0 && (
        <div className="anpr-dash-empty">Loading detections…</div>
      )}

      {!isLoading && allPlates.length === 0 && (
        <div className="anpr-dash-empty">
          <ScanLine size={28} strokeWidth={1.5} />
          <p>No ANPR detections in the last 7 days.</p>
          <p className="anpr-dash-empty-hint">
            Start live analysis on{' '}
            <Link to="/visionflow">ANPR &amp; Speed</Link>
            {' '}or the{' '}
            <Link to="/visionflow/multicam">Camera wall</Link>
            {' '}— detections sync here automatically.
          </p>
        </div>
      )}

      {visiblePlates.length > 0 && (
        <>
          <div className="anpr-dash-list-head">
            <span>Plate</span>
            <span>Shop duration</span>
            <span>Segments · Camera</span>
            <span>Peak speed</span>
            <span>Vehicle</span>
            <span>Last seen</span>
          </div>
          <div className="anpr-dash-list">
            {visiblePlates.map(group => (
              <PlateRow
                key={group.plate}
                group={group}
                expanded={expandedPlates.has(group.plate)}
                onToggle={() => togglePlate(group.plate)}
                liveJobIds={liveJobIds}
              />
            ))}
          </div>
        </>
      )}

      {totalPlates > previewCount && (
        <div className="anpr-dash-footer">
          <span className="anpr-dash-footer-meta">
            Showing {visiblePlates.length} of {totalPlates} plates
            {totalSegments > 0 && ` · ${totalSegments} segments`}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAll(v => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${totalPlates} plates`}
            {showAll ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      )}
    </div>
  );
};
