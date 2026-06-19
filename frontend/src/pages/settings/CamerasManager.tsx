import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Cloud,
  Grid2X2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Video,
  Wifi,
  Power,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { camerasApi, type CameraInput, type RegistryCamera } from '../../services/api';
import { CameraChangeWifiDialog } from '../../components/CameraChangeWifiDialog';
import { CameraSetupWizard } from '../../components/CameraSetupWizard';

function extractApiError(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { message?: string; hint?: string; detail?: string };
    return [d.message, d.hint, d.detail].filter(Boolean).join(' — ') || 'Request failed';
  }
  return 'Request failed';
}

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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [wifiCam, setWifiCam] = useState<RegistryCamera | null>(null);
  const [expandedActions, setExpandedActions] = useState<string | null>(null);

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

  const submitAdd = async (form: CameraInput) => {
    const name = String(form.name || '').trim();
    setAdding(true);
    try {
      const payload: CameraInput = { ...form, name };
      if (payload.device_serial) payload.device_serial = String(payload.device_serial).trim().toUpperCase();
      const { data } = await camerasApi.create(payload, true);
      const bind = data.bind;
      const prov = data.provision;
      if (bind && !bind.ok) {
        toast.error(`Camera saved, but cloud bind failed: ${bind.error ?? 'unknown'}`, { duration: 11000 });
      } else if (prov && !prov.ok) {
        toast(`Camera added. Connect issue: ${prov.error ?? 'unknown'}`, { icon: 'ℹ️', duration: 8000 });
      } else {
        toast.success(`Camera "${data.camera.name}" added and connecting`);
      }
      setWizardOpen(false);
      await refresh();
    } catch (err) {
      toast.error(extractApiError(err), { duration: 9000 });
      throw err;
    } finally {
      setAdding(false);
    }
  };

  const doAction = async (id: string, action: () => Promise<unknown>, okMsg?: string) => {
    setBusyId(id);
    setExpandedActions(null);
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
      <div className="cameras-loading">
        <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> Loading cameras…
      </div>
    );
  }

  return (
    <div className="cameras-manager">
      <div className="cameras-toolbar">
        <p className="cameras-intro">
          Add as many cameras as you need. <strong>Dahua cloud</strong> uses Easy4IP (like DMSS);
          <strong> RTSP / NVR</strong> uses a stream URL. Each camera joins the live ANPR camera wall automatically.
        </p>
        <div className="cameras-toolbar-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
            <RefreshCw size={14} /> <span className="cameras-btn-label">Refresh</span>
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/visionflow/multicam')}>
            <Grid2X2 size={14} /> <span className="cameras-btn-label">Wall</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setWizardOpen(true)}>
            <Plus size={14} /> Add camera
          </button>
        </div>
      </div>

      {cameras.length === 0 ? (
        <div className="cameras-empty">
          <div className="cameras-empty-icon"><Video size={28} /></div>
          <h3>No cameras yet</h3>
          <p>Run the setup wizard to connect your first Dahua cloud or RTSP camera.</p>
          <button type="button" className="btn btn-primary" onClick={() => setWizardOpen(true)}>
            <Plus size={14} /> Set up camera
          </button>
        </div>
      ) : (
        <div className="cameras-list">
          {cameras.map(cam => {
            const isBusy = busyId === cam.id;
            const live = cam.live;
            const phase = tunnelPhase(cam);
            const actionsOpen = expandedActions === cam.id;

            return (
              <article key={cam.id} className="camera-card">
                <div className="camera-card-main">
                  <div className={`camera-card-icon ${cam.type === 'dahua_p2p' ? 'cloud' : 'rtsp'}`}>
                    {cam.type === 'dahua_p2p' ? <Cloud size={20} /> : <Video size={20} />}
                  </div>
                  <div className="camera-card-info">
                    <div className="camera-card-title-row">
                      <h3>{cam.name}</h3>
                      <span className="camera-card-slot">Slot {cam.slot_index + 1}</span>
                    </div>
                    <p className="camera-card-meta">
                      {cam.type === 'dahua_p2p'
                        ? `Easy4IP · ${cam.device_serial || 'no serial'}`
                        : (cam.rtsp_url || `rtsp://${cam.host}:${cam.rtsp_port}`)}
                    </p>
                    {phase && (
                      <p className={`camera-card-phase${(cam.tunnel as { running?: boolean })?.running ? ' ok' : ''}`}>
                        <Wifi size={12} /> {phase}
                      </p>
                    )}
                  </div>
                  <span className={`camera-card-status${live?.enabled ? ' live' : ''}`}>
                    {live?.enabled ? '● Live' : '○ Idle'}
                  </span>
                </div>

                <div className={`camera-card-actions${actionsOpen ? ' open' : ''}`}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => void toggleEnabled(cam)}>
                    <Power size={13} /> {cam.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => void connect(cam)}>
                    {isBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Connect'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => void test(cam)}>
                    Test
                  </button>
                  {(cam.type === 'dahua_p2p' || cam.id === 'hero-a1') && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setWifiCam(cam)}>
                      <Wifi size={13} /> Wi-Fi
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm camera-card-delete" disabled={isBusy} onClick={() => remove(cam)}>
                    <Trash2 size={13} />
                  </button>
                </div>

                <button
                  type="button"
                  className="camera-card-more"
                  aria-expanded={actionsOpen}
                  aria-label="Camera actions"
                  onClick={() => setExpandedActions(actionsOpen ? null : cam.id)}
                >
                  <MoreHorizontal size={18} />
                </button>
              </article>
            );
          })}
        </div>
      )}

      <p className="cameras-footnote">
        <AlertCircle size={14} />
        Cloud cameras can take up to ~90s on first connect. Many simultaneous feeds benefit from a GPU server.
      </p>

      <CameraSetupWizard
        open={wizardOpen}
        busy={adding}
        onClose={() => setWizardOpen(false)}
        onSubmit={submitAdd}
      />

      {wifiCam && (
        <CameraChangeWifiDialog
          cameraId={wifiCam.id}
          cameraName={wifiCam.name}
          deviceSerial={wifiCam.device_serial || ''}
          isOpen={!!wifiCam}
          onClose={() => setWifiCam(null)}
        />
      )}
    </div>
  );
};
