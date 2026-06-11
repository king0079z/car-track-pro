import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Loader2,
  Router,
  Sparkles,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import type { CameraInput, CameraType } from '../services/api';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 15,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

export const emptyCameraForm: CameraInput = {
  name: '',
  type: 'dahua_p2p',
  enabled: true,
  connection_mode: 'cloud_hls',
  device_serial: '',
  password: '',
  host: '',
  username: 'admin',
  stream: 'sub',
  rtsp_url: '',
  meter_per_pixel: 0,
};

type StepId = 'type' | 'identity' | 'connection' | 'calibration' | 'review';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'type', label: 'Type' },
  { id: 'identity', label: 'Name' },
  { id: 'connection', label: 'Connect' },
  { id: 'calibration', label: 'Speed' },
  { id: 'review', label: 'Review' },
];

function stepIndex(id: StepId): number {
  return STEPS.findIndex(s => s.id === id);
}

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (form: CameraInput) => Promise<void>;
}

export const CameraSetupWizard: React.FC<Props> = ({ open, busy, onClose, onSubmit }) => {
  const [step, setStep] = useState<StepId>('type');
  const [form, setForm] = useState<CameraInput>(emptyCameraForm);
  const [error, setError] = useState<string | null>(null);

  const setField = useCallback((key: keyof CameraInput, value: unknown) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setForm(emptyCameraForm);
    setStep('type');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (busy) return;
    reset();
    onClose();
  }, [busy, onClose, reset]);

  const validateStep = useCallback((id: StepId): string | null => {
    if (id === 'identity') {
      if (!String(form.name || '').trim()) return 'Give your camera a name (e.g. Front gate)';
    }
    if (id === 'connection') {
      if (form.type === 'dahua_p2p') {
        if (!String(form.device_serial || '').trim()) return 'Enter the device serial from the QR label';
        if (form.connection_mode === 'cloud_hls' && !String(form.password || '').trim()) {
          return 'Cloud mode needs the device admin password to bind the camera';
        }
      } else {
        const hasUrl = String(form.rtsp_url || '').trim();
        const hasHost = String(form.host || '').trim();
        if (!hasUrl && !hasHost) return 'Enter an RTSP URL or a LAN IP for the camera';
      }
    }
    return null;
  }, [form]);

  const goNext = useCallback(() => {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    const idx = stepIndex(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1].id);
  }, [step, validateStep]);

  const goBack = useCallback(() => {
    setError(null);
    const idx = stepIndex(step);
    if (idx > 0) setStep(STEPS[idx - 1].id);
  }, [step]);

  const finish = useCallback(async () => {
    for (const s of STEPS.slice(0, -1)) {
      const err = validateStep(s.id);
      if (err) {
        setError(err);
        setStep(s.id);
        return;
      }
    }
    await onSubmit(form);
    reset();
  }, [form, onSubmit, reset, validateStep]);

  const currentIdx = stepIndex(step);
  const progress = ((currentIdx + 1) / STEPS.length) * 100;

  const reviewRows = useMemo(() => {
    const rows: { k: string; v: string }[] = [
      { k: 'Type', v: form.type === 'dahua_p2p' ? 'Dahua cloud (Easy4IP)' : 'RTSP / NVR' },
      { k: 'Name', v: String(form.name || '—') },
    ];
    if (form.type === 'dahua_p2p') {
      rows.push(
        { k: 'Connection', v: String(form.connection_mode || 'cloud_hls') },
        { k: 'Serial', v: String(form.device_serial || '—').toUpperCase() },
        { k: 'LAN fallback', v: form.host ? String(form.host) : 'None' },
      );
    } else {
      rows.push(
        { k: 'RTSP URL', v: form.rtsp_url ? String(form.rtsp_url) : '—' },
        { k: 'LAN IP', v: form.host ? String(form.host) : '—' },
        { k: 'Username', v: String(form.username || 'admin') },
      );
    }
    rows.push({
      k: 'Speed calibration',
      v: form.meter_per_pixel ? `${form.meter_per_pixel} m/px` : 'System default',
    });
    return rows;
  }, [form]);

  if (!open) return null;

  return (
    <div className="camera-wizard-backdrop" onClick={handleClose} role="presentation">
      <div
        className="camera-wizard"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-wizard-title"
      >
        <header className="camera-wizard-header">
          <button type="button" className="camera-wizard-icon-btn" onClick={handleClose} disabled={busy} aria-label="Close">
            <X size={20} />
          </button>
          <div className="camera-wizard-header-text">
            <h2 id="camera-wizard-title">Set up camera</h2>
            <p>Step {currentIdx + 1} of {STEPS.length} · {STEPS[currentIdx].label}</p>
          </div>
        </header>

        <div className="camera-wizard-progress" aria-hidden="true">
          <div className="camera-wizard-progress-bar" style={{ width: `${progress}%` }} />
        </div>

        <div className="camera-wizard-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`camera-wizard-step-dot${i <= currentIdx ? ' done' : ''}${i === currentIdx ? ' active' : ''}`}
            />
          ))}
        </div>

        <div className="camera-wizard-body">
          {error && (
            <div className="camera-wizard-error" role="alert">{error}</div>
          )}

          {step === 'type' && (
            <div className="camera-wizard-panel">
              <h3>What kind of camera?</h3>
              <p className="camera-wizard-lead">
                Choose how this camera reaches CarTrack. Dahua cloud works anywhere without a site PC.
              </p>
              <div className="camera-wizard-type-grid">
                <button
                  type="button"
                  className={`camera-wizard-type-card${form.type === 'dahua_p2p' ? ' selected' : ''}`}
                  onClick={() => setField('type', 'dahua_p2p' as CameraType)}
                >
                  <div className="camera-wizard-type-icon cloud"><Cloud size={26} /></div>
                  <div className="camera-wizard-type-title">Dahua cloud</div>
                  <div className="camera-wizard-type-badge">Recommended</div>
                  <p>Easy4IP / Imou — serial + password, no on-site server. Hero A1, H3A, and most Wi-Fi PTZ models.</p>
                </button>
                <button
                  type="button"
                  className={`camera-wizard-type-card${form.type === 'rtsp' ? ' selected' : ''}`}
                  onClick={() => setField('type', 'rtsp' as CameraType)}
                >
                  <div className="camera-wizard-type-icon rtsp"><Video size={26} /></div>
                  <div className="camera-wizard-type-title">RTSP / NVR</div>
                  <p>Generic IP camera or NVR channel via RTSP URL or LAN credentials.</p>
                </button>
              </div>
            </div>
          )}

          {step === 'identity' && (
            <div className="camera-wizard-panel">
              <h3>Name this camera</h3>
              <p className="camera-wizard-lead">Used on the camera wall, ANPR panels, and alerts.</p>
              <label className="camera-wizard-field">
                <span style={labelStyle}>Display name</span>
                <input
                  style={inputStyle}
                  value={form.name ?? ''}
                  onChange={e => setField('name', e.target.value)}
                  placeholder="Front gate · Bay 1 · Parking"
                  autoFocus
                />
              </label>
            </div>
          )}

          {step === 'connection' && form.type === 'dahua_p2p' && (
            <div className="camera-wizard-panel">
              <h3>Cloud connection</h3>
              <p className="camera-wizard-lead">
                Find the serial on the camera label or DMSS. Remove the device from DMSS/Imou first — one cloud account per camera.
              </p>
              <label className="camera-wizard-field">
                <span style={labelStyle}>Connection mode</span>
                <select
                  style={inputStyle}
                  value={form.connection_mode ?? 'cloud_hls'}
                  onChange={e => setField('connection_mode', e.target.value)}
                >
                  <option value="cloud_hls">Cloud HLS (Easy4IP) — recommended</option>
                  <option value="auto">Auto — P2P tunnel, then LAN</option>
                  <option value="p2p">P2P tunnel only</option>
                  <option value="lan">Same Wi-Fi (LAN RTSP)</option>
                </select>
              </label>
              <label className="camera-wizard-field">
                <span style={labelStyle}>Device serial (SN)</span>
                <input
                  style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                  value={form.device_serial ?? ''}
                  onChange={e => setField('device_serial', e.target.value.toUpperCase())}
                  placeholder="BF0E4C7GAGB833C"
                  spellCheck={false}
                />
              </label>
              <label className="camera-wizard-field">
                <span style={labelStyle}>Device password</span>
                <input
                  style={inputStyle}
                  type="password"
                  value={form.password ?? ''}
                  onChange={e => setField('password', e.target.value)}
                  placeholder="Admin password from DMSS / Imou"
                  autoComplete="new-password"
                />
              </label>
              <label className="camera-wizard-field">
                <span style={labelStyle}>LAN IP (optional fallback)</span>
                <input
                  style={inputStyle}
                  value={form.host ?? ''}
                  onChange={e => setField('host', e.target.value)}
                  placeholder="192.168.1.x"
                  spellCheck={false}
                />
              </label>
              <div className="camera-wizard-tip">
                <Wifi size={16} />
                <span>After setup you can change Wi-Fi from Settings or the camera wall — no DMSS required.</span>
              </div>
            </div>
          )}

          {step === 'connection' && form.type === 'rtsp' && (
            <div className="camera-wizard-panel">
              <h3>Stream address</h3>
              <p className="camera-wizard-lead">Paste a full RTSP URL or enter LAN host + credentials.</p>
              <label className="camera-wizard-field">
                <span style={labelStyle}>RTSP URL</span>
                <input
                  style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                  value={form.rtsp_url ?? ''}
                  onChange={e => setField('rtsp_url', e.target.value)}
                  placeholder="rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101"
                  spellCheck={false}
                />
              </label>
              <div className="camera-wizard-or">or use LAN fields</div>
              <div className="camera-wizard-field-grid">
                <label className="camera-wizard-field">
                  <span style={labelStyle}>LAN IP</span>
                  <input style={inputStyle} value={form.host ?? ''} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.x" />
                </label>
                <label className="camera-wizard-field">
                  <span style={labelStyle}>Username</span>
                  <input style={inputStyle} value={form.username ?? ''} onChange={e => setField('username', e.target.value)} placeholder="admin" />
                </label>
                <label className="camera-wizard-field">
                  <span style={labelStyle}>Password</span>
                  <input style={inputStyle} type="password" value={form.password ?? ''} onChange={e => setField('password', e.target.value)} autoComplete="new-password" />
                </label>
              </div>
            </div>
          )}

          {step === 'calibration' && (
            <div className="camera-wizard-panel">
              <h3>Speed calibration <span className="camera-wizard-optional">Optional</span></h3>
              <p className="camera-wizard-lead">
                For accurate ANPR speed readings, enter metres per pixel. Leave 0 to use the global default.
              </p>
              <label className="camera-wizard-field">
                <span style={labelStyle}>Metres per pixel</span>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.001}
                  value={form.meter_per_pixel ?? 0}
                  onChange={e => setField('meter_per_pixel', parseFloat(e.target.value) || 0)}
                  placeholder="0 = system default"
                />
              </label>
              <div className="camera-wizard-tip">
                <Sparkles size={16} />
                <span>Measure a known distance on the road (metres) and divide by its length in pixels on screen.</span>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="camera-wizard-panel">
              <h3>Ready to connect</h3>
              <p className="camera-wizard-lead">We&apos;ll save the camera, bind it to the cloud (if applicable), and start the live feed.</p>
              <div className="camera-wizard-review">
                {reviewRows.map(row => (
                  <div key={row.k} className="camera-wizard-review-row">
                    <span>{row.k}</span>
                    <strong>{row.v}</strong>
                  </div>
                ))}
              </div>
              <div className="camera-wizard-tip">
                <Router size={16} />
                <span>First cloud connect can take up to ~90 seconds while the media gateway wakes up.</span>
              </div>
            </div>
          )}
        </div>

        <footer className="camera-wizard-footer">
          {currentIdx > 0 ? (
            <button type="button" className="btn btn-secondary camera-wizard-back" onClick={goBack} disabled={busy}>
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <span />
          )}
          {step !== 'review' ? (
            <button type="button" className="btn btn-primary camera-wizard-next" onClick={goNext}>
              Continue <ArrowRight size={16} />
            </button>
          ) : (
            <button type="button" className="btn btn-primary camera-wizard-next" disabled={busy} onClick={() => void finish()}>
              {busy ? (
                <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Connecting…</>
              ) : (
                <><CheckCircle2 size={16} /> Add &amp; connect</>
              )}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};
