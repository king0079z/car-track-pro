import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Wifi, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { camerasApi, type WifiNetwork } from '../services/api';

function extractErr(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof data === 'string') return data;
  return 'Request failed';
}

function signalBars(intensity?: number): string {
  const n = Math.max(0, Math.min(5, Math.round(intensity ?? 0)));
  return '▮'.repeat(n) + '▯'.repeat(5 - n);
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--border-light)', background: 'var(--bg-surface)',
  color: 'var(--text-primary)', fontSize: 13,
};

/**
 * In-app Wi-Fi switcher for a cloud (Easy4IP) camera. Scans nearby networks
 * via the Open Platform and switches the camera over — no DMSS needed, as long
 * as the camera is currently online via the cloud.
 */
export const CameraWifiDialog: React.FC<{
  cameraId: string;
  cameraName: string;
  isOpen: boolean;
  onClose: () => void;
}> = ({ cameraId, cameraName, isOpen, onClose }) => {
  const [current, setCurrent] = useState<string | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanning, setScanning] = useState(false);
  const [ssid, setSsid] = useState('');
  const [bssid, setBssid] = useState('');
  const [password, setPassword] = useState('');
  const [switching, setSwitching] = useState(false);

  const loadCurrent = useCallback(async () => {
    setLoadingCurrent(true);
    try {
      const { data } = await camerasApi.wifiCurrent(cameraId);
      setCurrent(data.ok ? (data.ssid ?? null) : null);
    } catch {
      setCurrent(null);
    } finally {
      setLoadingCurrent(false);
    }
  }, [cameraId]);

  useEffect(() => {
    if (!isOpen) return;
    setNetworks([]); setSsid(''); setBssid(''); setPassword('');
    void loadCurrent();
  }, [isOpen, loadCurrent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const scan = async () => {
    setScanning(true);
    try {
      const { data } = await camerasApi.wifiScan(cameraId);
      if (data.ok) {
        setNetworks(data.networks ?? []);
        if (!data.networks?.length) toast('No networks found near the camera', { icon: 'i' });
      } else {
        toast.error(data.error || 'Wi-Fi scan failed', { duration: 7000 });
      }
    } catch (err) {
      toast.error(extractErr(err), { duration: 7000 });
    } finally {
      setScanning(false);
    }
  };

  const pick = (n: WifiNetwork) => {
    setSsid(n.ssid);
    setBssid(n.bssid ?? '');
  };

  const submit = async () => {
    if (!ssid.trim()) { toast.error('Pick or type a Wi-Fi name (SSID)'); return; }
    if (!window.confirm(
      `Switch "${cameraName}" to Wi-Fi "${ssid}"?\n\nThe camera will reboot onto the new network and may be offline for up to ~2 minutes. If the password is wrong it will drop off the cloud and need DMSS to recover.`,
    )) return;
    setSwitching(true);
    try {
      const { data } = await camerasApi.wifiSet(cameraId, { ssid: ssid.trim(), bssid: bssid.trim(), password });
      if (data.ok) {
        toast.success(`Switching to "${ssid}" — camera is rebooting onto the new network`, { duration: 9000 });
        onClose();
      } else {
        toast.error(data.error || 'Wi-Fi switch failed', { duration: 9000 });
      }
    } catch (err) {
      toast.error(extractErr(err), { duration: 9000 });
    } finally {
      setSwitching(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-elevated)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid var(--border-light)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 800 }}>
            <Wifi size={18} color="#3b82f6" /> Camera Wi-Fi — {cameraName}
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Currently on:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {loadingCurrent ? 'checking…' : current ? current : 'unknown'}
            </strong>
          </div>

          <button type="button" className="btn btn-secondary" disabled={scanning} onClick={() => void scan()}
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start' }}>
            {scanning ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
            {scanning ? 'Scanning camera surroundings…' : 'Scan nearby networks'}
          </button>

          {networks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-light)', borderRadius: 10, padding: 6 }}>
              {networks.map((n, i) => (
                <button key={`${n.ssid}-${i}`} type="button" onClick={() => pick(n)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', borderRadius: 8,
                    border: `1px solid ${ssid === n.ssid ? 'rgba(59,130,246,0.5)' : 'transparent'}`,
                    background: ssid === n.ssid ? 'rgba(59,130,246,0.12)' : 'var(--bg-surface)', cursor: 'pointer', textAlign: 'left',
                  }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.ssid}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', flexShrink: 0 }} title={`Signal ${n.intensity ?? 0}/5`}>{signalBars(n.intensity)}</span>
                </button>
              ))}
            </div>
          )}

          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Wi-Fi name (SSID)</span>
            <input style={fieldStyle} value={ssid} onChange={e => setSsid(e.target.value)} placeholder="Pick above or type the network name" spellCheck={false} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Wi-Fi password</span>
            <input style={fieldStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="New network password" autoComplete="new-password" />
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '9px 11px' }}>
            <AlertTriangle size={15} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              The camera reboots onto the new Wi-Fi (offline up to ~2 min). Use the <strong>2.4 GHz</strong> band and the
              correct password — a wrong network drops it off the cloud and needs DMSS / Imou Life (local pairing) to recover.
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: 13 }}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={switching} onClick={() => void submit()}
              style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {switching ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Wifi size={14} />}
              {switching ? 'Switching…' : 'Switch Wi-Fi'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
