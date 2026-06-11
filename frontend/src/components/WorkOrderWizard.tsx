import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import SignatureCanvas from 'react-signature-canvas';
import toast from 'react-hot-toast';
import {
  Search, X, CheckCircle, ChevronRight, Zap, User, Phone, Mail,
  PlayCircle, CheckCircle2, Clock, Loader2, Car, ClipboardList,
  Shield, MapPin, ScanLine, ArrowRight, Printer, ArrowLeft,
  Sparkles, Timer, AlertTriangle, RotateCcw, Edit3, Hash,
} from 'lucide-react';
import { visitsApi, vehiclesApi, servicesApi, usersApi, anprApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import type { Service, ServiceCategory, InShopVehicle } from '../types';

const DRAFT_KEY = 'cartrack_wo_draft_v1';
const BAY_COUNT = 8;

const CAT_CONFIG: Record<ServiceCategory, { color: string; bg: string; label: string }> = {
  wash:        { color: 'var(--text-accent)', bg: 'rgba(37,99,235,0.1)', label: 'Wash' },
  detailing:   { color: 'var(--text-purple)', bg: 'rgba(139,92,246,0.1)', label: 'Detailing' },
  polish:      { color: '#f9a8d4', bg: 'rgba(236,72,153,0.1)', label: 'Polish' },
  repair:      { color: 'var(--text-danger)', bg: 'rgba(239,68,68,0.1)', label: 'Repair' },
  maintenance: { color: 'var(--text-warning)', bg: 'rgba(245,158,11,0.1)', label: 'Maintenance' },
  inspection:  { color: 'var(--text-cyan)', bg: 'rgba(6,182,212,0.1)', label: 'Inspection' },
  other:       { color: '#9ca3af', bg: 'rgba(75,85,99,0.1)', label: 'Other' },
};

type StepId = 'vehicle' | 'details' | 'services' | 'review' | 'signoff';

const STEPS: { id: StepId; label: string; short: string }[] = [
  { id: 'vehicle', label: 'Select vehicle', short: 'Vehicle' },
  { id: 'details', label: 'Customer & vehicle', short: 'Details' },
  { id: 'services', label: 'Services & staff', short: 'Services' },
  { id: 'review', label: 'Review order', short: 'Review' },
  { id: 'signoff', label: 'Supervisor sign-off', short: 'Sign-off' },
];

const STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  waiting: { label: 'Waiting', color: 'var(--text-warning)', bg: 'rgba(252,211,77,0.12)' },
  in_service: { label: 'In service', color: 'var(--text-accent)', bg: 'rgba(147,197,253,0.12)' },
  on_hold: { label: 'On hold', color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
};

export interface WorkOrderWizardInitial {
  plate?: string;
  detection_id?: number;
  owner_name?: string;
  owner_phone?: string;
  bay?: string;
}

interface SelectedService {
  id: number;
  price: number;
  name: string;
  staff_id?: number;
  duration_minutes?: number;
}

interface Props {
  mode?: 'page' | 'modal';
  open?: boolean;
  initial?: WorkOrderWizardInitial;
  onClose?: () => void;
}

function stepIndex(id: StepId): number {
  return STEPS.findIndex(s => s.id === id);
}

function fmtShopMins(m: number | null | undefined) {
  if (m == null || m < 0) return '—';
  const mins = Math.round(m);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function fmtDuration(mins: number) {
  if (mins < 60) return `~${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

export const WorkOrderWizard: React.FC<Props> = ({
  mode = 'page',
  open = true,
  initial,
  onClose,
}) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const sigRef = useRef<SignatureCanvas>(null);

  const [step, setStep] = useState<StepId>('vehicle');
  const [error, setError] = useState<string | null>(null);
  const [plate, setPlate] = useState(initial?.plate?.toUpperCase() || '');
  const [vehicleData, setVehicleData] = useState<any>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [signatureDrawn, setSignatureDrawn] = useState(false);
  const [serviceSearch, setServiceSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategory | 'all'>('all');
  const [priority, setPriority] = useState(false);
  const [loadingLastOrder, setLoadingLastOrder] = useState(false);
  const [bayAutoLabel, setBayAutoLabel] = useState<string | null>(null);

  const [selectedAnprIds, setSelectedAnprIds] = useState<number[]>(() => {
    if (!initial?.detection_id) return [];
    return Number.isFinite(initial.detection_id) ? [initial.detection_id] : [];
  });

  const [form, setForm] = useState({
    make: '', model: '', year: '', color: '', vehicle_type: 'sedan',
    customer_name: initial?.owner_name || '',
    customer_phone: initial?.owner_phone || '',
    customer_email: '',
    assigned_bay: initial?.bay || '',
    notes: '',
  });

  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [statusModal, setStatusModal] = useState<{ visitId: number; visitNumber: string } | null>(null);
  const [settingStatus, setSettingStatus] = useState(false);

  const { data: services = [] } = useQuery({
    queryKey: ['services'],
    queryFn: () => servicesApi.list().then(r => r.data),
  });

  const { data: inShopVehicles = [], isLoading: inShopLoading, refetch: refetchInShop } = useQuery({
    queryKey: ['visits-in-shop'],
    queryFn: () => visitsApi.inShop().then(r => r.data as InShopVehicle[]),
    refetchInterval: 12000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.roster().then(r => r.data),
  });

  const { activeOnFloor, awaitingWorkOrder, occupiedBays } = useMemo(() => {
    const active = inShopVehicles.filter(v => v.source === 'active_visit');
    const pending = inShopVehicles.filter(v => v.source === 'anpr_pending');
    const bays = new Set<number>();
    inShopVehicles.forEach(v => {
      if (v.assigned_bay != null && v.source === 'active_visit') bays.add(v.assigned_bay);
    });
    return { activeOnFloor: active, awaitingWorkOrder: pending, occupiedBays: bays };
  }, [inShopVehicles]);

  const { data: anprPlateData } = useQuery({
    queryKey: ['anpr-plate', plate],
    queryFn: () => anprApi.plate(plate.trim().toUpperCase()).then(r => r.data),
    enabled: stepIndex(step) >= 1 && plate.trim().length >= 2,
  });

  const anprUnlinked = useMemo(() => {
    const dets = (anprPlateData as {
      detections?: {
        id: number;
        visit_id?: number | null;
        detected_at?: string;
        duration_sec?: number | null;
        suggested_bay?: number | null;
        camera_name?: string | null;
      }[];
    } | undefined)?.detections ?? [];
    const weekAgo = Date.now() - 7 * 86400000;
    return dets
      .filter(d => !d.visit_id && (!d.detected_at || new Date(d.detected_at).getTime() >= weekAgo))
      .slice(0, 24);
  }, [anprPlateData]);

  const primaryDetectionId = selectedAnprIds[0] ?? initial?.detection_id;

  const { data: detectionMeta } = useQuery({
    queryKey: ['anpr-detection', primaryDetectionId],
    queryFn: () => anprApi.detection(primaryDetectionId!).then(r => r.data as {
      suggested_bay?: number | null;
      camera_name?: string | null;
    }),
    enabled: !!primaryDetectionId,
  });

  const applySuggestedBay = useCallback((bay: number | null | undefined, cameraName?: string | null) => {
    if (bay == null || bay < 1) return;
    setForm(f => {
      if (f.assigned_bay && f.assigned_bay !== String(bay)) return f;
      return { ...f, assigned_bay: String(bay) };
    });
    setBayAutoLabel(cameraName ? `${cameraName} · Bay ${bay}` : `Camera · Bay ${bay}`);
  }, []);

  const anprIdsForSubmit = useMemo(() => {
    if (selectedAnprIds.length) return selectedAnprIds;
    return anprUnlinked.map(d => d.id);
  }, [selectedAnprIds, anprUnlinked]);

  const anprCameraTotalSec = useMemo(
    () => anprUnlinked.reduce((s, d) => s + (d.duration_sec ?? 0), 0),
    [anprUnlinked],
  );

  const mutation = useMutation({
    mutationFn: (data: any) => visitsApi.create(data),
    onSuccess: (res) => {
      localStorage.removeItem(DRAFT_KEY);
      qc.invalidateQueries({ queryKey: ['visits'] });
      qc.invalidateQueries({ queryKey: ['visits-in-shop'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      setStatusModal({ visitId: res.data.id, visitNumber: res.data.visit_number });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Failed to create work order'),
  });

  const saveDraft = useCallback(() => {
    if (!plate.trim() && selectedServices.length === 0) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        step, plate, form, selectedServices, priority, selectedAnprIds,
        savedAt: Date.now(),
      }));
    } catch { /* ignore */ }
  }, [step, plate, form, selectedServices, priority, selectedAnprIds]);

  useEffect(() => {
    const t = setTimeout(saveDraft, 400);
    return () => clearTimeout(t);
  }, [saveDraft]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw || initial?.plate) return;
      const d = JSON.parse(raw);
      if (Date.now() - (d.savedAt ?? 0) > 86400000) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      if (d.plate) setPlate(d.plate);
      if (d.form) setForm((f) => ({ ...f, ...d.form }));
      if (d.selectedServices) setSelectedServices(d.selectedServices);
      if (d.priority) setPriority(d.priority);
      if (d.selectedAnprIds) setSelectedAnprIds(d.selectedAnprIds);
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initial?.plate && plate.trim() && step === 'vehicle' && !vehicleData && !lookingUp) {
      void lookupPlate(initial.plate);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (detectionMeta?.suggested_bay) {
      applySuggestedBay(detectionMeta.suggested_bay, detectionMeta.camera_name);
    }
  }, [detectionMeta, applySuggestedBay]);

  useEffect(() => {
    if (detectionMeta?.suggested_bay || form.assigned_bay) return;
    const fromList = anprUnlinked.find(d => d.suggested_bay);
    if (fromList?.suggested_bay) {
      applySuggestedBay(fromList.suggested_bay, fromList.camera_name);
    }
  }, [anprUnlinked, detectionMeta, form.assigned_bay, applySuggestedBay]);

  useEffect(() => {
    if (initial?.bay && !bayAutoLabel) {
      setBayAutoLabel('Pre-filled from ANPR action');
    }
  }, [initial?.bay, bayAutoLabel]);

  useEffect(() => {
    if (step !== 'signoff') setSignatureDrawn(false);
  }, [step]);

  const lookupPlate = async (plateOverride?: string) => {
    const p = (plateOverride ?? plate).trim();
    if (!p) return;
    if (plateOverride) setPlate(plateOverride.toUpperCase());
    setLookingUp(true);
    setError(null);
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
        customer_name: res.data.owner_name || f.customer_name,
        customer_phone: res.data.owner_phone || f.customer_phone,
        customer_email: res.data.owner_email || f.customer_email,
      }));
      toast.success(`Found — ${res.data.total_visits} previous visit${res.data.total_visits !== 1 ? 's' : ''}`);
    } catch {
      setVehicleData(null);
      toast('New vehicle — fill in details on the next step', { icon: '🆕' });
    } finally {
      setLookingUp(false);
      setStep('details');
    }
  };

  const startWorkOrderForVehicle = async (v: InShopVehicle) => {
    if (v.source === 'active_visit' && v.visit_id) {
      toast(`Work order ${v.work_order_number} is already open`, { icon: '📋' });
      navigate(`/visits/${v.visit_id}`);
      return;
    }
    setSelectedAnprIds(v.anpr_detection_ids ?? []);
    if (v.suggested_bay) {
      applySuggestedBay(v.suggested_bay, v.camera_name);
    }
    if (v.customer_name && !form.customer_name) {
      setForm(f => ({ ...f, customer_name: v.customer_name || f.customer_name }));
    }
    await lookupPlate(v.plate_number);
  };

  const repeatLastOrder = async () => {
    if (!vehicleData?.id) return;
    setLoadingLastOrder(true);
    try {
      const res = await vehiclesApi.history(vehicleData.id);
      const visits = res.data?.visits ?? [];
      const last = visits[0];
      if (!last?.services?.length) {
        toast('No previous services to repeat', { icon: 'ℹ️' });
        return;
      }
      const svcList = services as Service[];
      const mapped: SelectedService[] = [];
      for (const s of last.services) {
        const match = svcList.find(x => x.name === s.service_name);
        if (match) {
          mapped.push({ id: match.id, price: s.price ?? match.base_price, name: match.name, duration_minutes: match.estimated_duration_minutes });
        }
      }
      if (!mapped.length) {
        toast('Could not match previous services to current catalog', { icon: '⚠️' });
        return;
      }
      setSelectedServices(mapped);
      toast.success(`Loaded ${mapped.length} service${mapped.length !== 1 ? 's' : ''} from last visit`);
    } catch {
      toast.error('Could not load visit history');
    } finally {
      setLoadingLastOrder(false);
    }
  };

  const toggleService = (svc: Service) => {
    setSelectedServices(prev => {
      if (prev.find(s => s.id === svc.id)) return prev.filter(s => s.id !== svc.id);
      return [...prev, { id: svc.id, price: svc.base_price, name: svc.name, duration_minutes: svc.estimated_duration_minutes }];
    });
  };

  const setServiceStaff = (svcId: number, staffId: number) => {
    setSelectedServices(prev => prev.map(s => s.id === svcId ? { ...s, staff_id: staffId || undefined } : s));
  };

  const setServicePrice = (svcId: number, price: number) => {
    setSelectedServices(prev => prev.map(s => s.id === svcId ? { ...s, price: Math.max(0, price) } : s));
  };

  const totalPrice = selectedServices.reduce((s, i) => s + i.price, 0);
  const totalDuration = selectedServices.reduce((s, i) => s + (i.duration_minutes ?? 0), 0);

  const grouped = useMemo(() => {
    return (services as Service[]).reduce((acc: Record<string, Service[]>, svc) => {
      if (!svc.is_active) return acc;
      if (!acc[svc.category]) acc[svc.category] = [];
      acc[svc.category].push(svc);
      return acc;
    }, {});
  }, [services]);

  const filteredServices = useMemo(() => {
    const q = serviceSearch.trim().toLowerCase();
    let list = (services as Service[]).filter(s => s.is_active);
    if (categoryFilter !== 'all') list = list.filter(s => s.category === categoryFilter);
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q) || s.category.includes(q));
    return list;
  }, [services, serviceSearch, categoryFilter]);

  const categoriesPresent = useMemo(
    () => Object.keys(grouped) as ServiceCategory[],
    [grouped],
  );

  const validateStep = useCallback((id: StepId): string | null => {
    if (id === 'vehicle') {
      if (!plate.trim()) return 'Enter a plate number or pick a vehicle from the shop floor';
    }
    if (id === 'details') {
      if (!plate.trim()) return 'Plate number is required';
    }
    if (id === 'services') {
      if (selectedServices.length === 0) return 'Select at least one service';
    }
    if (id === 'signoff') {
      const pad = sigRef.current;
      if (!pad || (pad.isEmpty() && !signatureDrawn)) return 'Supervisor signature is required';
    }
    return null;
  }, [plate, selectedServices.length, signatureDrawn]);

  const goNext = useCallback(() => {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const idx = stepIndex(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1].id);
  }, [step, validateStep]);

  const goBack = useCallback(() => {
    setError(null);
    const idx = stepIndex(step);
    if (idx > 0) setStep(STEPS[idx - 1].id);
  }, [step]);

  const jumpToStep = (id: StepId) => {
    const target = stepIndex(id);
    const current = stepIndex(step);
    if (target < current) {
      setError(null);
      setStep(id);
    }
  };

  const handleClose = () => {
    if (mutation.isPending) return;
    saveDraft();
    if (onClose) onClose();
    else navigate('/visits');
  };

  const buildNotes = () => {
    const parts: string[] = [];
    if (priority) parts.push('[PRIORITY]');
    if (form.notes.trim()) parts.push(form.notes.trim());
    return parts.join(' ') || undefined;
  };

  const handleSubmit = () => {
    const err = validateStep('signoff');
    if (err) { setError(err); return; }
    const pad = sigRef.current!;
    let supervisor_signature: string;
    try {
      supervisor_signature = pad.getTrimmedCanvas().toDataURL('image/png');
    } catch {
      supervisor_signature = pad.toDataURL('image/png');
    }
    mutation.mutate({
      plate_number: plate.toUpperCase(),
      vehicle_id: vehicleData?.id,
      ...(anprIdsForSubmit.length ? { anpr_detection_ids: anprIdsForSubmit } : {}),
      vehicle_type: form.vehicle_type || undefined,
      make: form.make || undefined,
      model: form.model || undefined,
      year: form.year ? parseInt(form.year) : undefined,
      color: form.color || undefined,
      owner_name: form.customer_name || undefined,
      owner_phone: form.customer_phone || undefined,
      owner_email: form.customer_email || undefined,
      assigned_bay: form.assigned_bay ? parseInt(form.assigned_bay) : undefined,
      customer_name: form.customer_name || undefined,
      customer_phone: form.customer_phone || undefined,
      customer_email: form.customer_email || undefined,
      notes: buildNotes(),
      entry_method: 'manual',
      supervisor_signature,
      service_ids: selectedServices.map(s => ({
        service_id: s.id,
        price: s.price,
        assigned_staff_id: s.staff_id || undefined,
      })),
    });
  };

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

  const currentIdx = stepIndex(step);
  const progress = ((currentIdx + 1) / STEPS.length) * 100;

  const reviewRows = useMemo((): { k: string; v: string; mono?: boolean; accent?: boolean; warn?: boolean }[] => [
    { k: 'Plate', v: plate.toUpperCase(), mono: true },
    { k: 'Vehicle', v: [form.make, form.model, form.year].filter(Boolean).join(' ') || '—' },
    { k: 'Customer', v: form.customer_name || '—' },
    { k: 'Phone', v: form.customer_phone || '—' },
    { k: 'Bay', v: form.assigned_bay ? `Bay ${form.assigned_bay}` : 'Not assigned' },
    { k: 'Services', v: selectedServices.map(s => s.name).join(', ') || 'None' },
    { k: 'Est. time', v: totalDuration ? fmtDuration(totalDuration) : '—' },
    { k: 'Total', v: `QAR ${totalPrice.toLocaleString()}`, accent: true },
    ...(priority ? [{ k: 'Priority', v: 'Yes', warn: true }] : []),
  ], [plate, form, selectedServices, totalDuration, totalPrice, priority]);

  if (mode === 'modal' && !open) return null;

  const inner = (
    <div className={mode === 'page' ? 'wo-wizard-page-inner' : 'wo-wizard'} role={mode === 'modal' ? 'dialog' : undefined} aria-modal={mode === 'modal' ? true : undefined}>
      <header className="wo-wizard-header">
        {mode === 'modal' ? (
          <button type="button" className="wo-wizard-icon-btn" onClick={handleClose} disabled={mutation.isPending} aria-label="Close">
            <X size={20} />
          </button>
        ) : (
          <button type="button" className="wo-wizard-icon-btn" onClick={handleClose} aria-label="Cancel">
            <X size={18} />
          </button>
        )}
        <div className="wo-wizard-header-text">
          <h1 id="wo-wizard-title">
            <ClipboardList size={22} className="wo-wizard-title-icon" />
            New work order
          </h1>
          <p>Step {currentIdx + 1} of {STEPS.length} · {STEPS[currentIdx].label}</p>
        </div>
        {mode === 'page' && (
          <button type="button" className="btn btn-secondary btn-sm wo-wizard-cancel-desktop" onClick={handleClose}>
            Cancel
          </button>
        )}
      </header>

      <div className="wo-wizard-progress" aria-hidden="true">
        <div className="wo-wizard-progress-bar" style={{ width: `${progress}%` }} />
      </div>

      <nav className="wo-wizard-steps" aria-label="Wizard progress">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`wo-wizard-step-pill${i <= currentIdx ? ' done' : ''}${i === currentIdx ? ' active' : ''}`}
            onClick={() => i < currentIdx && jumpToStep(s.id)}
            disabled={i >= currentIdx}
            title={s.label}
          >
            <span className="wo-wizard-step-num">{i < currentIdx ? '✓' : i + 1}</span>
            <span className="wo-wizard-step-label">{s.short}</span>
          </button>
        ))}
      </nav>

      <div className="wo-wizard-body">
        {error && <div className="wo-wizard-error" role="alert">{error}</div>}

        {/* Step 1 — Vehicle */}
        {step === 'vehicle' && (
          <div className="wo-wizard-panel">
            <h2>Select vehicle</h2>
            <p className="wo-wizard-lead">
              Search by plate or pick from the live shop floor. Camera-detected vehicles appear automatically.
            </p>

            <div className="wo-plate-search">
              <div className="wo-plate-input-wrap">
                <Hash size={18} className="wo-plate-hash" />
                <input
                  className="wo-plate-input"
                  placeholder="PLATE NUMBER"
                  value={plate}
                  onChange={e => setPlate(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && void lookupPlate()}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <button type="button" className="btn btn-primary wo-plate-btn" onClick={() => void lookupPlate()} disabled={lookingUp || !plate.trim()}>
                {lookingUp ? <Loader2 size={18} className="spin" /> : <Search size={18} />}
                {lookingUp ? 'Looking up…' : 'Continue'}
              </button>
            </div>

            <div className="wo-shop-floor">
              <div className="wo-shop-floor-head">
                <div>
                  <h3><MapPin size={16} /> Shop floor</h3>
                  <p>Live list · refreshes every 12s</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refetchInShop()}>
                  {inShopLoading ? <Loader2 size={14} className="spin" /> : null}
                  Refresh
                </button>
              </div>

              {inShopLoading && inShopVehicles.length === 0 ? (
                <div className="wo-empty-state">
                  <Loader2 size={28} className="spin" />
                  <span>Loading shop floor…</span>
                </div>
              ) : (
                <>
                  {awaitingWorkOrder.length > 0 && (
                    <section className="wo-floor-section">
                      <div className="wo-floor-section-label anpr">
                        <ScanLine size={13} /> On camera — no work order ({awaitingWorkOrder.length})
                      </div>
                      <div className="wo-vehicle-grid">
                        {awaitingWorkOrder.map(v => (
                          <button key={`anpr-${v.plate_number}`} type="button" className="wo-vehicle-card anpr" onClick={() => void startWorkOrderForVehicle(v)}>
                            <span className="wo-vehicle-plate">{v.plate_number}</span>
                            <span className="wo-vehicle-meta">Camera detected · register now</span>
                            {v.camera_name && (
                              <span className="wo-vehicle-sub">{v.camera_name}{v.suggested_bay ? ` · Bay ${v.suggested_bay}` : ''}</span>
                            )}
                            {(v.make || v.customer_name) && (
                              <span className="wo-vehicle-sub">{[v.make, v.model].filter(Boolean).join(' ')}{v.customer_name ? ` · ${v.customer_name}` : ''}</span>
                            )}
                            <span className="wo-vehicle-action">Start work order <ChevronRight size={12} /></span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {activeOnFloor.length > 0 && (
                    <section className="wo-floor-section">
                      <div className="wo-floor-section-label active">
                        <Car size={13} /> Currently being served ({activeOnFloor.length})
                      </div>
                      <div className="wo-vehicle-grid">
                        {activeOnFloor.map(v => {
                          const chip = STATUS_CHIP[v.status ?? 'waiting'] ?? STATUS_CHIP.waiting;
                          return (
                            <button key={`active-${v.plate_number}-${v.visit_id}`} type="button" className="wo-vehicle-card active" onClick={() => void startWorkOrderForVehicle(v)}>
                              <span className="wo-vehicle-plate accent">{v.plate_number}</span>
                              <span className="wo-vehicle-meta">{v.work_order_number}</span>
                              <div className="wo-vehicle-chips">
                                <span className="wo-chip" style={{ color: chip.color, background: chip.bg }}>{chip.label}</span>
                                {v.assigned_bay != null && <span className="wo-chip neutral">Bay {v.assigned_bay}</span>}
                                <span className="wo-chip muted">{fmtShopMins(v.minutes_in_shop)} in shop</span>
                              </div>
                              <span className="wo-vehicle-action blue">Open work order <ArrowRight size={12} /></span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {activeOnFloor.length === 0 && awaitingWorkOrder.length === 0 && (
                    <div className="wo-empty-state dashed">
                      <Car size={32} />
                      <strong>No vehicles on the floor</strong>
                      <span>Enter a plate above to continue</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Step 2 — Details */}
        {step === 'details' && (
          <div className="wo-wizard-panel">
            <h2>Customer &amp; vehicle</h2>
            <p className="wo-wizard-lead">Confirm vehicle details, assign a bay, and capture customer contact info.</p>

            {vehicleData && (
              <div className="wo-banner success">
                <CheckCircle size={18} />
                <div>
                  <strong>Returning customer</strong>
                  <span>{vehicleData.total_visits} visit{vehicleData.total_visits !== 1 ? 's' : ''}
                    {vehicleData.last_visit && ` · Last visit ${new Date(vehicleData.last_visit).toLocaleDateString()}`}
                  </span>
                </div>
              </div>
            )}

            {anprUnlinked.length > 0 && (
              <div className="wo-banner warning">
                <Zap size={18} />
                <div>
                  <strong>ANPR data will be linked</strong>
                  <span>
                    {anprUnlinked.length} detection{anprUnlinked.length !== 1 ? 's' : ''}
                    {anprCameraTotalSec > 0 && ` · ${anprCameraTotalSec >= 60 ? `${(anprCameraTotalSec / 60).toFixed(1)} min` : `${Math.round(anprCameraTotalSec)}s`} camera time`}
                  </span>
                </div>
              </div>
            )}

            <div className="wo-bay-picker">
              <div className="wo-bay-picker-head">
                <span className="wo-field-label">Assign bay</span>
                {bayAutoLabel && (
                  <span className="wo-bay-auto-badge">
                    <ScanLine size={12} /> Auto: {bayAutoLabel}
                  </span>
                )}
              </div>
              <div className="wo-bay-grid">
                <button
                  type="button"
                  className={`wo-bay-btn${!form.assigned_bay ? ' selected' : ''}`}
                  onClick={() => setForm(f => ({ ...f, assigned_bay: '' }))}
                >
                  None
                </button>
                {Array.from({ length: BAY_COUNT }, (_, i) => i + 1).map(b => {
                  const occupied = occupiedBays.has(b);
                  const selected = form.assigned_bay === String(b);
                  return (
                    <button
                      key={b}
                      type="button"
                      className={`wo-bay-btn${selected ? ' selected' : ''}${occupied && !selected ? ' occupied' : ''}`}
                      onClick={() => setForm(f => ({ ...f, assigned_bay: String(b) }))}
                      title={occupied ? 'Bay currently in use' : `Bay ${b}`}
                    >
                      {b}
                      {occupied && !selected && <span className="wo-bay-dot" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="wo-field-grid">
              <label className="wo-wizard-field span-2">
                <span className="wo-field-label">Plate number *</span>
                <input className="wo-input mono" value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label">Make</span>
                <input className="wo-input" placeholder="Toyota" value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label">Model</span>
                <input className="wo-input" placeholder="Camry" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label">Year</span>
                <input className="wo-input" type="number" placeholder="2024" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label">Color</span>
                <input className="wo-input" placeholder="White" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label">Vehicle type</span>
                <select className="wo-input" value={form.vehicle_type} onChange={e => setForm(f => ({ ...f, vehicle_type: e.target.value }))}>
                  {['sedan', 'suv', 'truck', 'van', 'motorcycle', 'other'].map(t => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="wo-section-divider">Customer</div>

            <div className="wo-field-grid">
              <label className="wo-wizard-field">
                <span className="wo-field-label"><User size={11} /> Name</span>
                <input className="wo-input" value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} />
              </label>
              <label className="wo-wizard-field">
                <span className="wo-field-label"><Phone size={11} /> Phone</span>
                <input className="wo-input" type="tel" value={form.customer_phone} onChange={e => setForm(f => ({ ...f, customer_phone: e.target.value }))} />
              </label>
              <label className="wo-wizard-field span-2">
                <span className="wo-field-label"><Mail size={11} /> Email <span className="wo-optional">optional</span></span>
                <input className="wo-input" type="email" value={form.customer_email} onChange={e => setForm(f => ({ ...f, customer_email: e.target.value }))} placeholder="customer@email.com" />
              </label>
            </div>

            <label className="wo-wizard-field">
              <span className="wo-field-label">Notes</span>
              <textarea className="wo-input wo-textarea" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Special instructions, damage notes…" rows={3} />
            </label>

            <label className="wo-priority-toggle">
              <input type="checkbox" checked={priority} onChange={e => setPriority(e.target.checked)} />
              <AlertTriangle size={16} />
              <span>Mark as priority — vehicle gets expedited handling</span>
            </label>
          </div>
        )}

        {/* Step 3 — Services */}
        {step === 'services' && (
          <div className="wo-wizard-panel">
            <div className="wo-services-head">
              <div>
                <h2>Services &amp; staff</h2>
                <p className="wo-wizard-lead" style={{ marginBottom: 0 }}>Pick services, adjust pricing, and assign technicians.</p>
              </div>
              {vehicleData?.id && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void repeatLastOrder()} disabled={loadingLastOrder}>
                  {loadingLastOrder ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                  Repeat last order
                </button>
              )}
            </div>

            <div className="wo-service-toolbar">
              <div className="wo-search-wrap">
                <Search size={16} />
                <input
                  value={serviceSearch}
                  onChange={e => setServiceSearch(e.target.value)}
                  placeholder="Search services…"
                  className="wo-search-input"
                />
                {serviceSearch && (
                  <button type="button" className="wo-search-clear" onClick={() => setServiceSearch('')} aria-label="Clear search">
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="wo-category-chips">
                <button type="button" className={`wo-cat-chip${categoryFilter === 'all' ? ' active' : ''}`} onClick={() => setCategoryFilter('all')}>All</button>
                {categoriesPresent.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    className={`wo-cat-chip${categoryFilter === cat ? ' active' : ''}`}
                    style={categoryFilter === cat ? { borderColor: CAT_CONFIG[cat].color, color: CAT_CONFIG[cat].color } : undefined}
                    onClick={() => setCategoryFilter(cat)}
                  >
                    {CAT_CONFIG[cat]?.label ?? cat}
                  </button>
                ))}
              </div>
            </div>

            {selectedServices.length > 0 && (
              <div className="wo-selected-bar">
                <span><strong>{selectedServices.length}</strong> selected</span>
                <span className="wo-selected-divider" />
                <span><Timer size={13} /> {fmtDuration(totalDuration)}</span>
                <span className="wo-selected-divider" />
                <span className="wo-selected-total">QAR {totalPrice.toLocaleString()}</span>
              </div>
            )}

            {serviceSearch || categoryFilter !== 'all' ? (
              <div className="wo-service-grid">
                {filteredServices.map(svc => {
                  const sel = selectedServices.find(s => s.id === svc.id);
                  const cfg = CAT_CONFIG[svc.category] || CAT_CONFIG.other;
                  return (
                    <button key={svc.id} type="button" className={`wo-service-card${sel ? ' selected' : ''}`} onClick={() => toggleService(svc)}>
                      <span className="wo-service-cat" style={{ color: cfg.color, background: cfg.bg }}>{cfg.label}</span>
                      <span className="wo-service-name">{svc.name}</span>
                      <span className="wo-service-meta">
                        ~{svc.estimated_duration_minutes}m · QAR {svc.base_price}
                      </span>
                    </button>
                  );
                })}
                {filteredServices.length === 0 && (
                  <div className="wo-empty-state dashed" style={{ gridColumn: '1 / -1' }}>
                    <Search size={24} />
                    <span>No services match your search</span>
                  </div>
                )}
              </div>
            ) : (
              Object.entries(grouped).map(([cat, svcs]) => {
                const cfg = CAT_CONFIG[cat as ServiceCategory] || CAT_CONFIG.other;
                return (
                  <div key={cat} className="wo-service-category">
                    <div className="wo-service-category-label" style={{ color: cfg.color }}>{cfg.label}</div>
                    <div className="wo-service-grid">
                      {(svcs as Service[]).map(svc => {
                        const sel = selectedServices.find(s => s.id === svc.id);
                        return (
                          <button key={svc.id} type="button" className={`wo-service-card${sel ? ' selected' : ''}`} onClick={() => toggleService(svc)}>
                            <span className="wo-service-name">{svc.name}</span>
                            <span className="wo-service-meta">
                              ~{svc.estimated_duration_minutes}m · QAR {svc.base_price}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}

            {selectedServices.length > 0 && (
              <div className="wo-staff-section">
                <div className="wo-section-divider"><User size={12} /> Staff assignment</div>
                <div className="wo-staff-list">
                  {selectedServices.map(s => (
                    <div key={s.id} className="wo-staff-row">
                      <div className="wo-staff-row-info">
                        <span className="wo-staff-name">{s.name}</span>
                        <div className="wo-staff-price-row">
                          <span>QAR</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            className="wo-price-input"
                            value={s.price}
                            onChange={e => setServicePrice(s.id, parseFloat(e.target.value) || 0)}
                          />
                        </div>
                      </div>
                      {(users as any[]).length > 0 && (
                        <select
                          className="wo-staff-select"
                          value={s.staff_id || ''}
                          onChange={e => setServiceStaff(s.id, Number(e.target.value))}
                        >
                          <option value="">Assign staff</option>
                          {(users as any[]).map((u: any) => (
                            <option key={u.id} value={u.id}>{u.full_name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 4 — Review */}
        {step === 'review' && (
          <div className="wo-wizard-panel">
            <h2>Review work order</h2>
            <p className="wo-wizard-lead">Confirm everything before supervisor sign-off.</p>

            <div className="wo-review-card">
              {reviewRows.map(row => (
                <div key={row.k} className={`wo-review-row${row.accent ? ' accent' : ''}${row.warn ? ' warn' : ''}`}>
                  <span>{row.k}</span>
                  <strong className={row.mono ? 'mono' : ''}>{row.v}</strong>
                </div>
              ))}
            </div>

            {selectedServices.length > 0 && (
              <div className="wo-review-services">
                <div className="wo-section-divider">Line items</div>
                {selectedServices.map(s => (
                  <div key={s.id} className="wo-review-line">
                    <span>{s.name}</span>
                    <span>QAR {s.price.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="wo-review-edits">
              <button type="button" className="wo-edit-link" onClick={() => jumpToStep('vehicle')}><Edit3 size={13} /> Vehicle</button>
              <button type="button" className="wo-edit-link" onClick={() => jumpToStep('details')}><Edit3 size={13} /> Details</button>
              <button type="button" className="wo-edit-link" onClick={() => jumpToStep('services')}><Edit3 size={13} /> Services</button>
            </div>

            <div className="wo-wizard-tip">
              <Sparkles size={16} />
              <span>After sign-off you can set status to Waiting, In Progress, or Completed and print the work order.</span>
            </div>
          </div>
        )}

        {/* Step 5 — Sign-off */}
        {step === 'signoff' && (
          <div className="wo-wizard-panel">
            <div className="wo-signoff-header">
              <div className="wo-signoff-icon"><Shield size={22} /></div>
              <div>
                <h2>Supervisor sign-off</h2>
                <p className="wo-wizard-lead" style={{ marginBottom: 0 }}>
                  Authorize as <strong>{user?.full_name ?? 'Supervisor'}</strong> before issuing the work order.
                </p>
              </div>
            </div>

            <div className={`wo-signature-pad${signatureDrawn ? ' signed' : ''}`}>
              <SignatureCanvas
                ref={sigRef}
                clearOnResize={false}
                penColor="#1e3a8a"
                onBegin={() => setSignatureDrawn(true)}
                onEnd={() => setSignatureDrawn(true)}
                canvasProps={{
                  width: 560,
                  height: 180,
                  style: { width: '100%', height: 180, display: 'block', touchAction: 'none' },
                }}
              />
            </div>
            <div className="wo-signature-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { sigRef.current?.clear(); setSignatureDrawn(false); }}>
                <X size={12} /> Clear
              </button>
              {!signatureDrawn && <span className="wo-sig-required">Signature required</span>}
            </div>

            <div className="wo-review-card compact">
              <div className="wo-review-row accent">
                <span>Total</span>
                <strong>QAR {totalPrice.toLocaleString()}</strong>
              </div>
              <div className="wo-review-row">
                <span>Plate</span>
                <strong className="mono">{plate}</strong>
              </div>
              <div className="wo-review-row">
                <span>Services</span>
                <strong>{selectedServices.length}</strong>
              </div>
            </div>
          </div>
        )}
      </div>

      <footer className="wo-wizard-footer">
        {currentIdx > 0 ? (
          <button type="button" className="btn btn-secondary wo-wizard-back" onClick={goBack} disabled={mutation.isPending}>
            <ArrowLeft size={16} /> Back
          </button>
        ) : (
          <span />
        )}
        {step !== 'signoff' ? (
          <button type="button" className="btn btn-primary wo-wizard-next" onClick={goNext}>
            Continue <ArrowRight size={16} />
          </button>
        ) : (
          <button type="button" className="btn btn-primary wo-wizard-next" disabled={mutation.isPending} onClick={handleSubmit}>
            {mutation.isPending ? (
              <><Loader2 size={16} className="spin" /> Issuing…</>
            ) : (
              <><ClipboardList size={16} /> Issue work order</>
            )}
          </button>
        )}
      </footer>
    </div>
  );

  return (
    <>
      {mode === 'page' ? (
        <div className="wo-wizard-page animate-fade-in">{inner}</div>
      ) : (
        <div className="wo-wizard-backdrop" onClick={handleClose} role="presentation">
          <div onClick={e => e.stopPropagation()}>{inner}</div>
        </div>
      )}

      {statusModal && (
        <div className="wo-status-modal-backdrop">
          <div className="wo-status-modal">
            <div className="wo-status-modal-head">
              <div className="wo-status-icon"><Zap size={24} /></div>
              <h2>Work order issued</h2>
              <p><strong>{statusModal.visitNumber}</strong> — set status or print</p>
            </div>
            <div className="wo-status-options">
              <button type="button" disabled={settingStatus} className="wo-status-opt progress" onClick={() => applyStatus('in_service')}>
                <PlayCircle size={20} />
                <div><strong>In progress</strong><span>Work has started</span></div>
              </button>
              <button type="button" disabled={settingStatus} className="wo-status-opt done" onClick={() => applyStatus('completed')}>
                <CheckCircle2 size={20} />
                <div><strong>Completed</strong><span>Mark done &amp; log exit</span></div>
              </button>
              <button type="button" disabled={settingStatus} className="wo-status-opt wait" onClick={() => applyStatus('waiting')}>
                <Clock size={20} />
                <div><strong>Keep waiting</strong><span>Queued for later</span></div>
              </button>
            </div>
            {settingStatus ? (
              <div className="wo-status-loading"><Loader2 size={14} className="spin" /> Updating…</div>
            ) : (
              <button
                type="button"
                className="btn btn-secondary wo-print-btn"
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
        </div>
      )}
    </>
  );
};
