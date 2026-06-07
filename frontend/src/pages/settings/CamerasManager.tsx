import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Cloud,
  Grid2X2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Video,
  Wifi,
  Power,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { camerasApi, type CameraInput, type CameraType, type RegistryCamera } from '../../services/api';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 14,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
};

function extractApiError(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { message?: string; hint?: string; detail?: string };
    return [d.message, d.hint, d.detail].filter(Boolean).join(' — ') || 'Request failed';
  }
  return 'Request failed';
}

const emptyForm: CameraInput = {
  name: '',
  type: 'dahua_p2p',
  enabled: true,
  connection_mode: 'auto',
  device_serial: '',
  password: '',
  host: '',
  username: 'admin',
  stream: 'sub',
  rtsp_url: '',
  meter_per_pixel: 0,
};

function tunnelPhase(cam: RegistryCamera): string | null {
  const t = cam.tunnel as { phase?: string; phase_message?: string; running?: boolean } | null | undefined;
  if (!t) return null;
  if (t.running) return 'Cloud tunnel ready';
  return t.phase_message || (t.phase ? `Tunnel: ${t.phase}` : null);
}

export const CamerasManager: React.FC = () => {
  const navigate = useNavigate();
  const [cameras, setCameras] = useState<RegistryCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<CameraInput>(emptyForm);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await camerasApi.list();
      setCameras(data.cameras ?? []);
    } catch {
      toast.error('Could not load cameras');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const setField = (key: keyof CameraInput, value: unknown) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const submitAdd = async () => {
    const name = String(form.name || '').trim();
    if (!name) {
      toast.error('Give the camera a name');
      return;
    }
    if (form.type === 'dahua_p2p' && !String(form.device_serial || '').trim()) {
      toast.error('Dahua cloud camera needs a device serial (SN from QR)');
      return;
    }
    if (form.type === 'rtsp' && !String(form.rtsp_url || '').trim() && !String(form.host || '').trim()) {
      toast.error('RTSP camera needs an RTSP URL or a LAN IP');
      return;
    }
    setAdding(true);
    try {
      const payload: CameraInput = { ...form, name };
      if (payload.device_serial) payload.device_serial = String(payload.device_serial).trim().toUpperCase();
      const { data } = await camerasApi.create(payload, true);
      const prov = data.provision;
      if (prov && !prov.ok) {
        toast(`Camera added. Connect issue: ${prov.error ?? 'unknown'}`, { icon: 'i', duration: 8000 });
      } else {
        toast.success(`Camera "${data.camera.name}" added and connecting`);
      }
      setForm(emptyForm);
      setShowAdd(false);
      await refresh();
    } catch (err) {
      toast.error(extractApiError(err), { duration: 9000 });
    } finally {
      setAdding(false);
    }
  };

  const doAction = async (id: string, action: () => Promise<unknown>, okMsg?: string) => {
    setBusyId(id);
    try {
      await action();
      if (okMsg) toast.success(okMsg);
      await refresh();
    } catch (err) {
      toast.error(extractApiError(err), { duration: 9000 });
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (cam: RegistryCamera) =>
    doAction(
      cam.id,
      () => camerasApi.update(cam.id, { enabled: !cam.enabled }, true),
      cam.enabled ? 'Camera disabled' : 'Camera enabled and connecting',
    );

  const connect = (cam: RegistryCamera) => doAction(cam.id, () => camerasApi.connect(cam.id), 'Connecting camera…');

  const test = (cam: RegistryCamera) =>
    doAction(cam.id, async () => {
      const { data } = await camerasApi.test(cam.id);
      if (data.ok) toast.success(`Stream OK — ${data.width}x${data.height} @ ${Math.round(data.fps ?? 0)}fps`);
      else toast.error(data.error || 'Stream not reachable', { duration: 8000 });
    });

  const remove = (cam: RegistryCamera) => {
    if (!window.confirm(`Delete camera "${cam.name}"? This stops its live feed.`)) return;
    void doAction(cam.id, () => camerasApi.remove(cam.id), 'Camera deleted');
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: 'var(--text-muted)' }}>
        <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> Loading cameras…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, maxWidth: 620 }}>
          Add as many cameras as you need. <strong>Dahua cloud</strong> cameras connect via Easy4IP (like DMSS) with
          their own serial and password; <strong>RTSP / NVR</strong> cameras connect by URL. Each camera auto-joins the
          live ANPR camera wall.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/visionflow/multicam')} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Grid2X2 size={14} /> Camera wall
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(v => !v)} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Add camera
          </button>
        </div>
      </div>

      {showAdd && (
        <div style={{ padding: '16px 18px', borderRadius: 14, border: '1px solid var(--border-light)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(['dahua_p2p', 'rtsp'] as CameraType[]).map(t => (
              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                <input type="radio" name="ctype" checked={form.type === t} onChange={() => setField('type', t)} />
                {t === 'dahua_p2p' ? <><Cloud size={16} /> Dahua cloud (Easy4IP)</> : <><Video size={16} /> RTSP / NVR</>}
              </label>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={labelStyle}>Camera name</span>
              <input style={inputStyle} value={form.name ?? ''} onChange={e => setField('name', e.target.value)} placeholder="Front gate" />
            </label>

            {form.type === 'dahua_p2p' ? (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>Device serial (SN)</span>
                  <input style={inputStyle} value={form.device_serial ?? ''} onChange={e => setField('device_serial', e.target.value.toUpperCase())} placeholder="BF0E4C7GAGB833C" spellCheck={false} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>Device password</span>
                  <input style={inputStyle} type="password" value={form.password ?? ''} onChange={e => setField('password', e.target.value)} placeholder="From DMSS device settings" autoComplete="new-password" />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>LAN IP (optional fallback)</span>
                  <input style={inputStyle} value={form.host ?? ''} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.x from DMSS" spellCheck={false} />
                </label>
              </>
            ) : (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>RTSP URL</span>
                  <input style={inputStyle} value={form.rtsp_url ?? ''} onChange={e => setField('rtsp_url', e.target.value)} placeholder="rtsp://user:pass@host:554/Streaming/Channels/101" spellCheck={false} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>…or LAN IP</span>
                  <input style={inputStyle} value={form.host ?? ''} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.x" spellCheck={false} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>Username</span>
                  <input style={inputStyle} value={form.username ?? ''} onChange={e => setField('username', e.target.value)} placeholder="admin" spellCheck={false} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={labelStyle}>Password</span>
                  <input style={inputStyle} type="password" value={form.password ?? ''} onChange={e => setField('password', e.target.value)} autoComplete="new-password" />
                </label>
              </>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Speed calibration — metres per pixel (optional)</span>
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={0.5}
                step={0.001}
                value={form.meter_per_pixel ?? 0}
                onChange={e => setField('meter_per_pixel', parseFloat(e.target.value) || 0)}
                placeholder="0 = auto (use global default)"
              />
              <span style={{ fontSize: 11, opacity: 0.7 }}>
                Set this per camera for accurate speed: divide a known real-world distance (m) on the road
                by its length in pixels on screen. Leave 0 to use the system default.
              </span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={adding} onClick={() => void submitAdd()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {adding ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
              Add &amp; connect
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => { setShowAdd(false); setForm(emptyForm); }} style={{ fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {cameras.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-light)', borderRadius: 12 }}>
          No cameras yet. Click <strong>Add camera</strong> to connect your first one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cameras.map(cam => {
            const isBusy = busyId === cam.id;
            const live = cam.live;
            const phase = tunnelPhase(cam);
            return (
              <div key={cam.id} style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border-light)', background: 'var(--bg-surface)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: cam.type === 'dahua_p2p' ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {cam.type === 'dahua_p2p' ? <Cloud size={20} color="#60a5fa" /> : <Video size={20} color="#10b981" />}
                </div>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {cam.name}
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                      Slot {cam.slot_index + 1}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, wordBreak: 'break-all' }}>
                    {cam.type === 'dahua_p2p' ? `Easy4IP · ${cam.device_serial || 'no serial'}` : (cam.rtsp_url || `rtsp://${cam.host}:${cam.rtsp_port}`)}
                  </div>
                  {phase && (
                    <div style={{ fontSize: 11, marginTop: 4, color: (cam.tunnel as { running?: boolean })?.running ? '#10b981' : '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Wifi size={12} /> {phase}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '4px 10px',
                      borderRadius: 999,
                      background: live?.enabled ? 'rgba(16,185,129,0.12)' : 'rgba(148,163,184,0.12)',
                      color: live?.enabled ? '#10b981' : 'var(--text-muted)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    {live?.enabled ? '● Live' : '○ Idle'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={() => void toggleEnabled(cam)} title={cam.enabled ? 'Disable' : 'Enable'} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Power size={13} /> {cam.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={() => void connect(cam)} title="Reconnect" style={{ fontSize: 12 }}>
                    {isBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Connect'}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={() => void test(cam)} title="Test stream" style={{ fontSize: 12 }}>
                    Test
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={() => remove(cam)} title="Delete" style={{ fontSize: 12, color: '#ef4444' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        Cloud cameras can take up to ~90s for the Easy4IP tunnel on first connect. Running many cameras at once is
        compute-heavy — a GPU server is recommended beyond a few simultaneous feeds.
      </p>
    </div>
  );
};
