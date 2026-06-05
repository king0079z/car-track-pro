import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Car, CheckCircle2, AlertCircle, Loader2, Plus, ArrowRight, User, Phone,
} from 'lucide-react';

export interface SyncedDetection {
  id: number;
  plate: string;
  speed_kmh: number | null;
  vehicle_id: number | null;
  vehicle: {
    id: number;
    plate_number: string;
    make: string | null;
    model: string | null;
    owner_name: string | null;
    owner_phone: string | null;
    total_visits: number;
  } | null;
  visit_id: number | null;
  detected_at: string;
  job_id?: string;
  t_enter_sec?: number | null;
  t_exit_sec?: number | null;
  duration_sec?: number | null;
}

export interface PlateAction {
  plate: string;
  jobId: string;
  panelLabel?: string;
  detectionId: number | null;
  vehicle: SyncedDetection['vehicle'] | null;
  linkedVisitId: number | null;
  state: 'idle' | 'loading' | 'found' | 'not_found' | 'creating' | 'created' | 'error';
  error?: string;
}

export function detectionsToPlateActions(
  detections: SyncedDetection[],
  jobId: string,
  panelLabel?: string,
): Record<string, PlateAction> {
  const out: Record<string, PlateAction> = {};
  for (const d of detections) {
    const key = plateActionKey(jobId, d.plate);
    out[key] = {
      plate: d.plate,
      jobId,
      panelLabel,
      detectionId: d.id,
      vehicle: d.vehicle,
      linkedVisitId: d.visit_id,
      state: d.visit_id ? 'created' : d.vehicle ? 'found' : 'not_found',
    };
  }
  return out;
}

export function plateActionKey(jobId: string, plate: string) {
  return `${jobId}:${plate}`;
}

export const PlateActionCard: React.FC<{
  pa: PlateAction;
  /** @deprecated Use work-order wizard navigation instead */
  onCreateVisit?: (pa: PlateAction, extra: { owner_name?: string; owner_phone?: string; assigned_bay?: number }) => void;
}> = ({ pa, onCreateVisit }) => {
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
    if (extra?.assigned_bay != null) params.set('bay', String(extra.assigned_bay));
    navigate(`/visits/new?${params.toString()}`);
  };

  const bg = pa.state === 'found' ? 'rgba(16,185,129,0.06)' : pa.state === 'not_found' ? 'rgba(245,158,11,0.06)' : pa.state === 'created' ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)';
  const border = pa.state === 'found' ? 'rgba(16,185,129,0.25)' : pa.state === 'not_found' ? 'rgba(245,158,11,0.25)' : pa.state === 'created' ? 'rgba(16,185,129,0.3)' : 'var(--border-light)';

  return (
    <div style={{ borderRadius: 14, border: `1px solid ${border}`, background: bg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Car size={15} color="var(--blue)" />
          </div>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {pa.plate}
          </span>
          {pa.panelLabel && (
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', color: 'var(--text-muted)' }}>
              {pa.panelLabel}
            </span>
          )}
          {pa.vehicle && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {[pa.vehicle.make, pa.vehicle.model].filter(Boolean).join(' ') || ''}
            </span>
          )}
        </div>
        {pa.state === 'loading' && <Loader2 size={14} color="var(--blue)" style={{ animation: 'spin 1s linear infinite' }} />}
        {pa.state === 'found' && <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} /> In database</span>}
        {pa.state === 'not_found' && <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={12} /> Not registered</span>}
        {pa.state === 'created' && <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} /> Work order opened</span>}
        {pa.state === 'error' && <span style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={12} /> {pa.error}</span>}
      </div>

      {pa.state === 'found' && pa.vehicle && (
        <div style={{ background: 'var(--bg-surface)', borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border-light)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12, marginBottom: 10 }}>
            <span style={{ color: 'var(--text-muted)' }}>Owner</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{pa.vehicle.owner_name || '—'}</span>
            <span style={{ color: 'var(--text-muted)' }}>Phone</span>
            <span style={{ color: 'var(--text-primary)' }}>{pa.vehicle.owner_phone || '—'}</span>
            <span style={{ color: 'var(--text-muted)' }}>Total visits</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{pa.vehicle.total_visits}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '7px 16px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => openWorkOrderWizard()}
            >
              <Plus size={12} /> New work order
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => navigate(`/vehicles/${pa.vehicle!.id}`)}
            >
              <ArrowRight size={12} /> View profile
            </button>
          </div>
        </div>
      )}

      {pa.state === 'not_found' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            This plate is not in CarTrack yet. Register the owner and open a work order:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8 }}>
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
            type="button"
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

      {pa.state === 'created' && pa.linkedVisitId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Work order opened successfully.</span>
          <button type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => navigate(`/visits/${pa.linkedVisitId}`)}>
            <ArrowRight size={11} /> Open work order
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
