import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, X, CheckCircle, ChevronRight, Zap, User,
  PlayCircle, CheckCircle2, Clock, Loader2, Car, ClipboardList,
  Shield, MapPin, ScanLine, ArrowRight, Printer,
} from 'lucide-react';
import { visitsApi, vehiclesApi, servicesApi, usersApi, anprApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import SignatureCanvas from 'react-signature-canvas';
import toast from 'react-hot-toast';
import type { Service, ServiceCategory, InShopVehicle } from '../../types';

const CAT_CONFIG: Record<ServiceCategory, { color: string; bg: string }> = {
  wash:        { color: 'var(--text-accent)', bg: 'rgba(37,99,235,0.1)' },
  detailing:   { color: 'var(--text-purple)', bg: 'rgba(139,92,246,0.1)' },
  polish:      { color: '#f9a8d4', bg: 'rgba(236,72,153,0.1)' },
  repair:      { color: 'var(--text-danger)', bg: 'rgba(239,68,68,0.1)' },
  maintenance: { color: 'var(--text-warning)', bg: 'rgba(245,158,11,0.1)' },
  inspection:  { color: 'var(--text-cyan)', bg: 'rgba(6,182,212,0.1)' },
  other:       { color: '#9ca3af', bg: 'rgba(75,85,99,0.1)' },
};

const STEPS = ['Select vehicle', 'Vehicle details', 'Services', 'Supervisor sign-off'];

const STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  waiting: { label: 'Waiting', color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)' },
  in_service: { label: 'In service', color: 'var(--text-accent)', bg: 'rgba(147,197,253,0.12)' },
  on_hold: { label: 'On hold', color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
};

export const NewVisit: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const sigRef = useRef<SignatureCanvas>(null);
  const [signatureDrawn, setSignatureDrawn] = useState(false);

  const [step, setStep] = useState(0);
  const [plate, setPlate] = useState(searchParams.get('plate') || '');
  const [vehicleData, setVehicleData] = useState<any>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [selectedAnprIds, setSelectedAnprIds] = useState<number[]>(() => {
    const raw = searchParams.get('detection_id');
    if (!raw) return [];
    const id = parseInt(raw, 10);
    return Number.isFinite(id) ? [id] : [];
  });

  const [form, setForm] = useState({
    make: '', model: '', year: '', color: '', vehicle_type: 'sedan',
    customer_name: searchParams.get('owner_name') || '',
    customer_phone: searchParams.get('owner_phone') || '',
    assigned_bay: searchParams.get('bay') || '',
    notes: '',
  });

  // service_id → { price, name, staff_id }
  const [selectedServices, setSelectedServices] = useState<{ id: number; price: number; name: string; staff_id?: number }[]>([]);

  const { data: services = [] } = useQuery({
    queryKey: ['services'],
    queryFn: () => servicesApi.list().then(r => r.data),
  });

  const { data: inShopVehicles = [], isLoading: inShopLoading, refetch: refetchInShop } = useQuery({
    queryKey: ['visits-in-shop'],
    queryFn: () => visitsApi.inShop().then(r => r.data as InShopVehicle[]),
    refetchInterval: 12000,
  });

  const { activeOnFloor, awaitingWorkOrder } = useMemo(() => ({
    activeOnFloor: inShopVehicles.filter(v => v.source === 'active_visit'),
    awaitingWorkOrder: inShopVehicles.filter(v => v.source === 'anpr_pending'),
  }), [inShopVehicles]);

  const { data: anprPlateData } = useQuery({
    queryKey: ['anpr-plate', plate],
    queryFn: () => anprApi.plate(plate.trim().toUpperCase()).then(r => r.data),
    enabled: step >= 1 && plate.trim().length >= 2,
  });

  const anprUnlinked = useMemo(() => {
    const dets = (anprPlateData as { detections?: { id: number; visit_id?: number | null; detected_at?: string; duration_sec?: number | null }[] } | undefined)?.detections ?? [];
    const weekAgo = Date.now() - 7 * 86400000;
    return dets
      .filter(d => !d.visit_id && (!d.detected_at || new Date(d.detected_at).getTime() >= weekAgo))
      .slice(0, 24);
  }, [anprPlateData]);

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const anprIdsForSubmit = useMemo(() => {
    if (selectedAnprIds.length) return selectedAnprIds;
    return anprUnlinked.map(d => d.id);
  }, [selectedAnprIds, anprUnlinked]);

  const anprCameraTotalSec = useMemo(
    () => anprUnlinked.reduce((s, d) => s + (d.duration_sec ?? 0), 0),
    [anprUnlinked],
  );

  const [statusModal, setStatusModal] = useState<{ visitId: number; visitNumber: string } | null>(null);
  const [settingStatus, setSettingStatus] = useState(false);

  const mutation = useMutation({
    mutationFn: (data: any) => visitsApi.create(data),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['visits'] });
      qc.invalidateQueries({ queryKey: ['visits-in-shop'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      // Show status selection modal instead of navigating immediately
      setStatusModal({ visitId: res.data.id, visitNumber: res.data.visit_number });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Failed to create work order'),
  });

  const applyStatus = async (status: 'waiting' | 'in_service' | 'completed') => {
    if (!statusModal) return;
    setSettingStatus(true);
    try {
      if (status !== 'waiting') {
        await visitsApi.update(statusModal.visitId, {
          status,
          ...(status === 'completed' ? { exit_time: new Date().toISOString() } : {}),
        });
      }
      qc.invalidateQueries({ queryKey: ['visits'] });
      qc.invalidateQueries({ queryKey: ['visits-in-shop'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      toast.success(
        status === 'completed' ? 'Work order completed ✓' :
        status === 'in_service' ? 'Work order marked in progress' :
        'Work order registered — waiting'
      );
      navigate(`/visits/${statusModal.visitId}${status === 'waiting' ? '?print=1' : ''}`);
    } catch {
      toast.error('Could not update status');
    } finally {
      setSettingStatus(false);
    }
  };

  const lookupPlate = async (plateOverride?: string) => {
    const p = (plateOverride ?? plate).trim();
    if (!p) return;
    if (plateOverride) setPlate(plateOverride.toUpperCase());
    setLookingUp(true);
    try {
      const res = await vehiclesApi.lookup(p.toUpperCase());
      setVehicleData(res.data);
      setForm(f => ({
        ...f,
        make: res.data.make || '',
        model: res.data.model || '',
        year: res.data.year?.toString() || '',
        color: res.data.color || '',
        vehicle_type: res.data.vehicle_type || 'sedan',
        customer_name: res.data.owner_name || '',
        customer_phone: res.data.owner_phone || '',
      }));
      toast.success(`Found — ${res.data.total_visits} previous visits`);
    } catch {
      setVehicleData(null);
      toast('New vehicle', { icon: '🆕' });
    } finally {
      setLookingUp(false);
      setStep(1);
    }
  };

  const startWorkOrderForVehicle = async (v: InShopVehicle) => {
    if (v.source === 'active_visit' && v.visit_id) {
      toast(`Work order ${v.work_order_number} is already open`, { icon: '📋' });
      navigate(`/visits/${v.visit_id}`);
      return;
    }
    setSelectedAnprIds(v.anpr_detection_ids ?? []);
    await lookupPlate(v.plate_number);
  };

  const fmtShopMins = (m: number | null | undefined) => {
    if (m == null || m < 0) return '—';
    const mins = Math.round(m);
    return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const toggleService = (svc: Service) => {
    setSelectedServices(prev => {
      if (prev.find(s => s.id === svc.id)) return prev.filter(s => s.id !== svc.id);
      return [...prev, { id: svc.id, price: svc.base_price, name: svc.name }];
    });
  };

  const setServiceStaff = (svcId: number, staffId: number) => {
    setSelectedServices(prev => prev.map(s => s.id === svcId ? { ...s, staff_id: staffId } : s));
  };

  // If plate pre-filled from URL, auto-lookup and advance to vehicle details
  useEffect(() => {
    if (searchParams.get('plate') && plate.trim()) {
      void lookupPlate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 3) setSignatureDrawn(false);
  }, [step]);

  const totalPrice = selectedServices.reduce((s, i) => s + i.price, 0);
  const grouped = (services as Service[]).reduce((acc: Record<string, Service[]>, svc) => {
    if (!acc[svc.category]) acc[svc.category] = [];
    acc[svc.category].push(svc);
    return acc;
  }, {});

  const handleSubmit = () => {
    if (!plate.trim()) { toast.error('Plate number required'); return; }
    const pad = sigRef.current;
    if (!pad || (pad.isEmpty() && !signatureDrawn)) {
      toast.error('Supervisor signature required to complete the work order');
      return;
    }
    let supervisor_signature: string | undefined;
    try {
      supervisor_signature = pad.getTrimmedCanvas().toDataURL('image/png');
    } catch {
      supervisor_signature = pad.toDataURL('image/png');
    }
    mutation.mutate({
      plate_number: plate.toUpperCase(),
      vehicle_id: vehicleData?.id,
      ...(anprIdsForSubmit.length ? { anpr_detection_ids: anprIdsForSubmit } : {}),
      // Vehicle detail fields — saved to Vehicle record
      vehicle_type: form.vehicle_type || undefined,
      make: form.make || undefined,
      model: form.model || undefined,
      year: form.year ? parseInt(form.year) : undefined,
      color: form.color || undefined,
      owner_name: form.customer_name || undefined,
      owner_phone: form.customer_phone || undefined,
      // Visit fields
      assigned_bay: form.assigned_bay ? parseInt(form.assigned_bay) : undefined,
      customer_name: form.customer_name || undefined,
      customer_phone: form.customer_phone || undefined,
      notes: form.notes || undefined,
      entry_method: 'manual',
      supervisor_signature,
      service_ids: selectedServices.map(s => ({
        service_id: s.id,
        price: s.price,
        assigned_staff_id: s.staff_id || undefined,
      })),
    });
  };

  const inputStyle = {
    width: '100%', padding: '10px 14px',
    background: 'var(--input-bg)',
    border: '1px solid var(--border)',
    borderRadius: 10, color: 'var(--text-primary)',
    fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: 800, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ClipboardList size={26} color="var(--blue)" />
            New work order
          </h1>
          <p className="page-desc">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>
        </div>
        <button className="btn btn-secondary" onClick={() => navigate('/visits')}>
          <X size={14} /> Cancel
        </button>
      </div>

      {/* Step Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 28, background: 'var(--bg-elevated)', borderRadius: 14, padding: '4px', border: '1px solid var(--border)' }}>
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <button
              onClick={() => i < step && setStep(i)}
              style={{
                flex: 1, padding: '10px 8px', borderRadius: 10, border: 'none', cursor: i < step ? 'pointer' : 'default',
                background: step === i ? 'rgba(37,99,235,0.2)' : step > i ? 'rgba(16,185,129,0.1)' : 'transparent',
                color: step === i ? 'var(--text-accent)' : step > i ? 'var(--text-success)' : 'var(--text-muted)',
                fontSize: 12.5, fontWeight: 600, transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: step === i ? '#2563eb' : step > i ? '#10b981' : 'var(--border)',
                color: step >= i ? 'white' : 'var(--text-muted)',
              }}>
                {step > i ? '✓' : i + 1}
              </span>
              <span className="truncate">{s}</span>
            </button>
            {i < STEPS.length - 1 && (
              <ChevronRight size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Step 0 — Select vehicle (plate search + shop floor) */}
      {step === 0 && (
        <div className="animate-scale-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Primary: plate lookup — same as original visit form */}
          <div className="card card-p">
            <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Search size={20} color="var(--blue)" />
              Step 1 — Select vehicle
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 20px', lineHeight: 1.6 }}>
              Enter the plate number or pick a car from the shop floor below. You will choose services and get supervisor sign-off in the next steps.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <input
                style={{ ...inputStyle, flex: 1, fontSize: 22, fontWeight: 800, fontFamily: 'monospace', textAlign: 'center', letterSpacing: 4, padding: '14px 18px' }}
                placeholder="PLATE NO"
                value={plate}
                onChange={e => setPlate(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && void lookupPlate()}
                autoFocus
              />
              <button type="button" className="btn btn-primary" onClick={() => void lookupPlate()} disabled={lookingUp || !plate.trim()} style={{ padding: '14px 24px', borderRadius: 12 }}>
                {lookingUp ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={18} />}
                {lookingUp ? '…' : 'Continue'}
              </button>
            </div>
          </div>

          <div className="card card-p">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <MapPin size={20} color="#10b981" />
                  Vehicles on shop floor
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0, maxWidth: 560, lineHeight: 1.6 }}>
                  Select a plate for a <strong>new work order</strong>, or open an existing order for cars still being served.
                  List refreshes every 12 seconds.
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refetchInShop()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {inShopLoading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                Refresh
              </button>
            </div>

            {inShopLoading && inShopVehicles.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', marginBottom: 12 }} />
                Loading shop floor…
              </div>
            ) : (
              <>
                {activeOnFloor.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Car size={13} /> Currently being served ({activeOnFloor.length})
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                      {activeOnFloor.map(v => {
                        const chip = STATUS_CHIP[v.status ?? 'waiting'] ?? STATUS_CHIP.waiting;
                        return (
                          <button
                            key={`active-${v.plate_number}-${v.visit_id}`}
                            type="button"
                            onClick={() => void startWorkOrderForVehicle(v)}
                            style={{
                              textAlign: 'left', padding: '16px 18px', borderRadius: 14, cursor: 'pointer',
                              border: '1px solid rgba(59,130,246,0.25)', background: 'linear-gradient(145deg, rgba(37,99,235,0.08), var(--bg-elevated))',
                              transition: 'all 0.18s',
                            }}
                          >
                            <div style={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 900, letterSpacing: 3, color: 'var(--text-accent)', marginBottom: 8 }}>{v.plate_number}</div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8 }}>{v.work_order_number}</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99, color: chip.color, background: chip.bg }}>{chip.label}</span>
                              {v.assigned_bay != null && (
                                <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--bg-surface)', border: '1px solid var(--border-light)' }}>Bay {v.assigned_bay}</span>
                              )}
                              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtShopMins(v.minutes_in_shop)} in shop</span>
                            </div>
                            {(v.make || v.customer_name) && (
                              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                {[v.make, v.model].filter(Boolean).join(' ')}{v.customer_name ? ` · ${v.customer_name}` : ''}
                              </div>
                            )}
                            <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 4 }}>
                              Open work order <ArrowRight size={12} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {awaitingWorkOrder.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#f59e0b', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ScanLine size={13} /> On camera — no work order yet ({awaitingWorkOrder.length})
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                      {awaitingWorkOrder.map(v => (
                        <button
                          key={`anpr-${v.plate_number}`}
                          type="button"
                          onClick={() => void startWorkOrderForVehicle(v)}
                          style={{
                            textAlign: 'left', padding: '16px 18px', borderRadius: 14, cursor: 'pointer',
                            border: '1px solid rgba(245,158,11,0.35)', background: 'linear-gradient(145deg, rgba(245,158,11,0.08), var(--bg-elevated))',
                          }}
                        >
                          <div style={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 900, letterSpacing: 3, color: 'var(--text-warning)', marginBottom: 8 }}>{v.plate_number}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Detected today · register work order</div>
                          {(v.make || v.customer_name) && (
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                              {[v.make, v.model].filter(Boolean).join(' ')}{v.customer_name ? ` · ${v.customer_name}` : ''}
                            </div>
                          )}
                          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
                            Start work order <ChevronRight size={12} />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {activeOnFloor.length === 0 && awaitingWorkOrder.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-muted)', borderRadius: 12, border: '1px dashed var(--border-light)' }}>
                    <Car size={28} style={{ opacity: 0.35, marginBottom: 8 }} />
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>No vehicles on the floor right now</div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>Use the plate search above.</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Step 1 — Vehicle Info */}
      {step === 1 && (
        <div className="card card-p animate-scale-in">
          {vehicleData && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
              borderRadius: 12, marginBottom: 24,
            }}>
              <CheckCircle size={20} color="#10b981" />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-success)' }}>Returning Vehicle</div>
                <div style={{ fontSize: 12, color: 'rgba(110,231,183,0.7)' }}>
                  {vehicleData.total_visits} previous visit{vehicleData.total_visits !== 1 ? 's' : ''}
                  {vehicleData.make && ` · ${vehicleData.make} ${vehicleData.model || ''}`}
                </div>
              </div>
            </div>
          )}

          {anprUnlinked.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 18px',
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 12, marginBottom: 20,
            }}>
              <Zap size={18} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-warning)' }}>ANPR camera data will be linked</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                  {anprUnlinked.length} recent detection{anprUnlinked.length !== 1 ? 's' : ''}
                  {anprCameraTotalSec > 0
                    ? <> with <strong>{anprCameraTotalSec >= 60 ? `${(anprCameraTotalSec / 60).toFixed(1)} min` : `${Math.round(anprCameraTotalSec)}s`}</strong> total in-frame time (VisionFlow). </>
                    : '. '}
                  Visit entry time is adjusted from camera dwell when timing data is present so in-shop duration stays meaningful.
                </div>
              </div>
            </div>
          )}

          <div className="grid-2" style={{ gap: 16, marginBottom: 16 }}>
            {[
              { label: 'Plate Number *', key: 'plate', value: plate, mono: true, fullWidth: false },
            ].map(() => (
              <div key="plate" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="label">Plate Number *</label>
                <input style={{ ...inputStyle, fontFamily: 'monospace', fontWeight: 800, fontSize: 18, letterSpacing: 3 }}
                  value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} />
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Assign Bay</label>
              <select style={inputStyle} value={form.assigned_bay} onChange={e => setForm(f => ({ ...f, assigned_bay: e.target.value }))}>
                <option value="">Not assigned</option>
                {[1,2,3,4,5].map(b => <option key={b} value={b}>Bay {b}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Make</label>
              <input style={inputStyle} placeholder="e.g. Toyota" value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Model</label>
              <input style={inputStyle} placeholder="e.g. Camry" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Year</label>
              <input style={inputStyle} type="number" placeholder="2024" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Color</label>
              <input style={inputStyle} placeholder="White" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Vehicle Type</label>
              <select style={inputStyle} value={form.vehicle_type} onChange={e => setForm(f => ({ ...f, vehicle_type: e.target.value }))}>
                {['sedan','suv','truck','van','motorcycle','other'].map(t => (
                  <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Customer Name</label>
              <input style={inputStyle} value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="label">Phone</label>
              <input style={inputStyle} value={form.customer_phone} onChange={e => setForm(f => ({ ...f, customer_phone: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
            <label className="label">Notes</label>
            <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setStep(0)}>Back</button>
            <button className="btn btn-primary" onClick={() => setStep(2)}>Services →</button>
          </div>
        </div>
      )}

      {/* Step 2 — Services */}
      {step === 2 && (
        <div className="card card-p animate-scale-in">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Select Services</h2>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Choose one or more services to perform</p>
            </div>
            {selectedServices.length > 0 && (
              <div style={{
                background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                borderRadius: 99, padding: '4px 14px',
                fontSize: 13, fontWeight: 700, color: 'var(--text-accent)',
              }}>
                {selectedServices.length} · QAR {totalPrice.toLocaleString()}
              </div>
            )}
          </div>

          {Object.entries(grouped).map(([cat, svcs]) => {
            const cfg = CAT_CONFIG[cat as ServiceCategory] || CAT_CONFIG.other;
            return (
              <div key={cat} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  {cat}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {(svcs as Service[]).map(svc => {
                    const sel = selectedServices.some(s => s.id === svc.id);
                    return (
                      <button
                        key={svc.id}
                        onClick={() => toggleService(svc)}
                        style={{
                          textAlign: 'left', padding: '12px 14px', borderRadius: 10,
                          border: `1px solid ${sel ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
                          background: sel ? 'rgba(37,99,235,0.12)' : 'var(--bg-elevated)',
                          cursor: 'pointer', transition: 'all 0.15s',
                          boxShadow: sel ? '0 0 0 2px rgba(59,130,246,0.15)' : 'none',
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600, color: sel ? 'var(--text-accent)' : 'var(--text-primary)', marginBottom: 4 }}>
                          {svc.name}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                            ~{svc.estimated_duration_minutes}m
                            {svc.is_auto_calculated ? ' avg' : ' est.'}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: sel ? 'var(--text-purple)' : 'var(--text-accent)' }}>
                            QAR {svc.base_price}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Staff Assignment for selected services */}
          {selectedServices.length > 0 && (users as any[]).length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div className="divider" />
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>
                <User size={11} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                Assign Staff (optional)
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selectedServices.map(s => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border-light)', borderRadius: 8,
                  }}>
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</div>
                    <select
                      style={{
                        background: 'var(--bg-base)', border: '1px solid var(--border)',
                        borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
                        padding: '5px 10px', fontFamily: 'inherit', outline: 'none',
                        minWidth: 140,
                      }}
                      value={s.staff_id || ''}
                      onChange={e => setServiceStaff(s.id, Number(e.target.value))}
                    >
                      <option value="">No staff assigned</option>
                      {(users as any[]).map((u: any) => (
                        <option key={u.id} value={u.id}>{u.full_name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="divider" style={{ marginTop: 20 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (selectedServices.length === 0) {
                  toast.error('Select at least one service');
                  return;
                }
                setStep(3);
              }}
            >
              Supervisor sign-off →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Supervisor sign-off */}
      {step === 3 && (
        <div className="card card-p animate-scale-in">
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20,
            padding: '14px 16px', borderRadius: 12, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
          }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(59,130,246,0.15)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Shield size={20} color="#3b82f6" />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>
                Supervisor sign-off
              </h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
                Authorize this work order before it is saved. Signing as{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{user?.full_name ?? 'Supervisor'}</strong>.
              </p>
            </div>
          </div>
          <div style={{
            border: `2px solid ${signatureDrawn ? 'rgba(16,185,129,0.45)' : 'var(--border)'}`,
            borderRadius: 14, overflow: 'hidden', background: '#fff', marginBottom: 16,
            boxShadow: signatureDrawn ? '0 0 0 3px rgba(16,185,129,0.12)' : 'none',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}>
            <SignatureCanvas
              ref={sigRef}
              clearOnResize={false}
              penColor="#1e3a8a"
              onBegin={() => setSignatureDrawn(true)}
              onEnd={() => setSignatureDrawn(true)}
              canvasProps={{
                width: 560,
                height: 200,
                style: { width: '100%', height: 200, display: 'block', touchAction: 'none' },
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                sigRef.current?.clear();
                setSignatureDrawn(false);
              }}
            >
              <X size={12} /> Clear signature
            </button>
            {!signatureDrawn && (
              <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>Required to complete work order</span>
            )}
          </div>

          {/* Summary */}
          <div style={{
            marginTop: 4, padding: 18, borderRadius: 12,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClipboardList size={14} /> Work order summary
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-muted)' }}>Plate:</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--text-accent)' }}>{plate}</span>
              <span style={{ color: 'var(--text-muted)' }}>Bay:</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{form.assigned_bay ? `Bay ${form.assigned_bay}` : 'Not assigned'}</span>
              <span style={{ color: 'var(--text-muted)' }}>Services:</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{selectedServices.length > 0 ? selectedServices.map(s => s.name).join(', ') : 'None'}</span>
              <span style={{ color: 'var(--text-muted)' }}>Total:</span>
              <span style={{ fontWeight: 700, color: 'var(--text-purple)' }}>QAR {totalPrice.toLocaleString()}</span>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 }}>
            <button className="btn btn-secondary" onClick={() => setStep(2)}>Back</button>
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={mutation.isPending}
              style={{ padding: '10px 28px', fontSize: 14 }}
            >
              {mutation.isPending
                ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
                : <><ClipboardList size={15} /> Issue work order</>}
            </button>
          </div>
        </div>
      )}

      {/* ══ STATUS SELECTION MODAL ══ */}
      {statusModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          <div
            style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 20, padding: '32px 28px', width: '100%', maxWidth: 440,
              boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              animation: 'scaleIn 0.2s ease',
            }}
          >
            {/* Header */}
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ width: 52, height: 52, borderRadius: 15, background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                <Zap size={24} color="#3b82f6" />
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 6px' }}>
                Work order issued
              </h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                <strong style={{ color: 'var(--blue)' }}>{statusModal.visitNumber}</strong> — set status or print the report
              </p>
            </div>

            {/* Options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* In Progress */}
              <button
                disabled={settingStatus}
                onClick={() => applyStatus('in_service')}
                style={{
                  width: '100%', padding: '16px 20px', borderRadius: 14, border: '1px solid rgba(59,130,246,0.35)',
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.12), rgba(37,99,235,0.06))',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                  transition: 'all 0.18s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.35)')}
              >
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <PlayCircle size={20} color="#3b82f6" />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>In Progress</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Work has started — show under active service</div>
                </div>
              </button>

              {/* Completed */}
              <button
                disabled={settingStatus}
                onClick={() => applyStatus('completed')}
                style={{
                  width: '100%', padding: '16px 20px', borderRadius: 14, border: '1px solid rgba(16,185,129,0.35)',
                  background: 'linear-gradient(135deg, rgba(16,185,129,0.1), rgba(5,150,105,0.05))',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                  transition: 'all 0.18s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#10b981')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(16,185,129,0.35)')}
              >
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <CheckCircle2 size={20} color="#10b981" />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>Completed</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Job is done — mark as completed and log exit time now</div>
                </div>
              </button>

              {/* Waiting */}
              <button
                disabled={settingStatus}
                onClick={() => applyStatus('waiting')}
                style={{
                  width: '100%', padding: '16px 20px', borderRadius: 14, border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                  transition: 'all 0.18s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(252,211,77,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Clock size={20} color="var(--text-warning)" />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>Keep Waiting</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Vehicle is queued — assign staff later</div>
                </div>
              </button>
            </div>

            {settingStatus && (
              <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Updating status…
              </div>
            )}
            {!settingStatus && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ width: '100%', marginTop: 14, justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: 8 }}
                onClick={() => {
                  const vid = statusModal.visitId;
                  setStatusModal(null);
                  navigate(`/visits/${vid}?print=1`);
                }}
              >
                <Printer size={14} /> Print work order
              </button>
            )}
          </div>
          <style>{`
            @keyframes fadeIn { from{opacity:0} to{opacity:1} }
            @keyframes scaleIn { from{transform:scale(0.93);opacity:0} to{transform:scale(1);opacity:1} }
            @keyframes spin { to{transform:rotate(360deg)} }
          `}</style>
        </div>
      )}
    </div>
  );
};
