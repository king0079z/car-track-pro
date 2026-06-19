import React, { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Radio, Wifi, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { camerasApi } from '../services/api';
import {
  browserConnectWifi,
  browserProbeAnyHost,
  browserScanWifi,
  DEFAULT_CAMERA_HOSTS,
  type LocalWifiNetwork,
} from '../services/dahuaLocalSetup';

const field: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 13,
};

type Props = {
  serial: string;
  securityCode: string;
  remoteServer?: boolean;
  onSerial: (sn: string) => void;
  onPasswordSaved: () => void;
};

/**
 * DMSS-style first-time Wi-Fi setup — at the shop on camera AP or same LAN.
 * Browser talks to the camera directly; cloud VPS cannot reach 192.168.x.
 */
export const CameraFirstTimeSetup: React.FC<Props> = ({
  serial,
  securityCode,
  remoteServer = false,
  onSerial,
  onPasswordSaved,
}) => {
  const [host, setHost] = useState('192.168.1.108');
  const [devicePassword, setDevicePassword] = useState('');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [networks, setNetworks] = useState<LocalWifiNetwork[]>([]);
  const [busy, setBusy] = useState('');
  const [statusLine, setStatusLine] = useState('');
  const [step, setStep] = useState(1);
  const [foundSerial, setFoundSerial] = useState('');
  const abortRef = useRef(false);

  const cancel = () => {
    abortRef.current = true;
    setBusy('');
    setStatusLine('');
    toast('Cancelled', { icon: '⏹' });
  };

  const discover = async () => {
    abortRef.current = false;
    setBusy('discover');
    setStatusLine('Probing camera on this device (5s per IP)…');
    try {
      const br = await browserProbeAnyHost([host, ...DEFAULT_CAMERA_HOSTS.filter(h => h !== host)], devicePassword);
      if (abortRef.current) return;
      if (br.ok && br.host) {
        setHost(br.host);
        setFoundSerial(br.serial || '');
        if (br.serial) onSerial(br.serial);
        toast.success(`Camera found at ${br.host}`);
        setStep(2);
        setStatusLine('');
        return;
      }

      if (!remoteServer) {
        setStatusLine('Trying CarTrack server on shop LAN…');
        const { data } = await camerasApi.localSetupDiscover();
        if (abortRef.current) return;
        const cam = data.cameras?.[0];
        if (cam?.host) {
          setHost(String(cam.host));
          if (cam.serial) {
            setFoundSerial(String(cam.serial));
            onSerial(String(cam.serial));
          }
          toast.success(`Camera found at ${cam.host} (via server)`);
          setStep(2);
          setStatusLine('');
          return;
        }
        toast.error(data.hint || 'No camera found on shop network', { duration: 9000 });
      } else {
        toast.error(
          'Cannot reach the camera from here. On this phone/PC: Settings → Wi‑Fi → join Dahua_XXXX hotspot, then tap Find camera again.',
          { duration: 12000 },
        );
      }
    } catch {
      toast.error('Discovery failed — join camera hotspot Dahua_XXXX first', { duration: 8000 });
    } finally {
      setBusy('');
      setStatusLine('');
    }
  };

  const scanWifi = async () => {
    abortRef.current = false;
    setBusy('scan');
    setNetworks([]);
    setStatusLine(`Scanning Wi‑Fi from camera at ${host}…`);
    try {
      let nets: LocalWifiNetwork[] = [];
      const br = await browserScanWifi(host, devicePassword);
      if (abortRef.current) return;
      if (br.ok && br.networks.length) {
        nets = br.networks;
      } else if (!remoteServer) {
        setStatusLine('Browser blocked — trying shop server…');
        const { data } = await camerasApi.localSetupWifiScan({
          host,
          password: devicePassword,
          username: 'admin',
        });
        if (abortRef.current) return;
        if (data.ok) nets = data.networks ?? [];
        else throw new Error(data.error || br.error || 'Scan failed');
      } else {
        throw new Error(
          br.error ||
            'Browser cannot reach the camera. Join Dahua_XXXX hotspot on this device, or type your shop Wi‑Fi name manually below.',
        );
      }
      setNetworks(nets);
      setStep(3);
      if (!nets.length) toast('No networks found — type SSID manually', { icon: 'i' });
      else toast.success(`Found ${nets.length} network(s)`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Wi‑Fi scan failed', { duration: 9000 });
    } finally {
      setBusy('');
      setStatusLine('');
    }
  };

  const connectWifi = async () => {
    if (!wifiSsid.trim()) {
      toast.error('Pick or enter shop Wi‑Fi name');
      return;
    }
    abortRef.current = false;
    setBusy('connect');
    setStatusLine(`Sending Wi‑Fi “${wifiSsid.trim()}” to camera at ${host}…`);
    try {
      let ok = false;
      let lastErr = '';
      const br = await browserConnectWifi(host, wifiSsid.trim(), wifiPassword, devicePassword);
      if (abortRef.current) return;
      ok = br.ok;
      lastErr = br.error || '';
      if (!ok && !remoteServer) {
        setStatusLine('Trying via shop server…');
        const { data } = await camerasApi.localSetupWifiConnect({
          host,
          ssid: wifiSsid.trim(),
          wifi_password: wifiPassword,
          device_password: devicePassword,
        });
        if (abortRef.current) return;
        ok = data.ok;
        lastErr = String(data.error || lastErr);
      }
      if (!ok) {
        throw new Error(
          lastErr ||
            (remoteServer
              ? 'Could not reach the camera. Join Dahua_XXXX hotspot on this device and try again — the cloud server cannot configure Wi‑Fi remotely.'
              : 'Connect failed'),
        );
      }
      if (devicePassword) {
        await camerasApi.updateHeroA1({
          enabled: true,
          device_serial: foundSerial || serial,
          host,
          password: devicePassword,
          security_code: securityCode || undefined,
          connection_mode: 'cartrack_cloud',
        });
        onPasswordSaved();
      }
      toast.success('Wi‑Fi sent to camera — wait 1–2 min, then Bind to CarPro & Connect', { duration: 10000 });
      setStep(4);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Wi‑Fi connect failed', { duration: 10000 });
    } finally {
      setBusy('');
      setStatusLine('');
    }
  };

  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid rgba(16,185,129,0.35)',
        background: 'rgba(16,185,129,0.06)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 14 }}>
        <Radio size={18} color="#10b981" />
        First-time Wi-Fi setup (like DMSS)
      </div>

      {remoteServer && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: '#f59e0b',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            lineHeight: 1.5,
          }}
        >
          <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            CarTrack runs in the cloud — Wi‑Fi setup only works from a device on the <strong>camera hotspot</strong>{' '}
            (Dahua_XXXX) or shop Wi‑Fi. Join that network on this phone/PC first, then run the steps below.
          </span>
        </p>
      )}

      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        Power on the camera → join hotspot <strong>Dahua_XXXX</strong> (IP usually <strong>192.168.1.108</strong>) →
        find camera → scan shop Wi‑Fi → send password. After 1–2 min the camera joins your shop network.
      </p>

      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <li style={{ color: step >= 1 ? 'var(--text-primary)' : undefined }}>Find camera on local network</li>
        <li style={{ color: step >= 2 ? 'var(--text-primary)' : undefined }}>Scan shop Wi‑Fi networks</li>
        <li style={{ color: step >= 3 ? 'var(--text-primary)' : undefined }}>Send Wi‑Fi password to camera</li>
        <li style={{ color: step >= 4 ? '#10b981' : undefined }}>Bind CarPro &amp; connect live feed</li>
      </ol>

      {statusLine && (
        <p style={{ margin: 0, fontSize: 12, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          {statusLine}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Camera IP</span>
          <input style={field} value={host} onChange={e => setHost(e.target.value)} spellCheck={false} disabled={!!busy} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Device password</span>
          <input
            style={field}
            type="password"
            value={devicePassword}
            onChange={e => setDevicePassword(e.target.value)}
            placeholder="Set during init (or blank if new)"
            disabled={!!busy}
          />
        </label>
      </div>

      {(step >= 3 || wifiSsid) && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Shop Wi‑Fi (SSID)</span>
            <input
              style={field}
              value={wifiSsid}
              onChange={e => setWifiSsid(e.target.value)}
              placeholder="Your shop 2.4 GHz network"
              disabled={!!busy}
            />
          </label>
          {networks.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {networks.map(n => (
                <button
                  key={`${n.ssid}-${n.bssid}`}
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12 }}
                  disabled={!!busy}
                  onClick={() => setWifiSsid(n.ssid)}
                >
                  {n.ssid}
                </button>
              ))}
            </div>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Shop Wi‑Fi password</span>
            <input
              style={field}
              type="password"
              value={wifiPassword}
              onChange={e => setWifiPassword(e.target.value)}
              disabled={!!busy}
            />
          </label>
        </>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void discover()} style={{ fontSize: 13 }}>
          {busy === 'discover' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
          1. Find camera
        </button>
        <button type="button" className="btn btn-secondary" disabled={!!busy || step < 2} onClick={() => void scanWifi()} style={{ fontSize: 13 }}>
          {busy === 'scan' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Wifi size={14} />}
          2. Scan Wi‑Fi
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!!busy || (step < 3 && !wifiSsid.trim())}
          onClick={() => void connectWifi()}
          style={{ fontSize: 13 }}
        >
          {busy === 'connect' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
          3. Connect to Wi‑Fi
        </button>
        {busy && (
          <button type="button" className="btn btn-secondary" onClick={cancel} style={{ fontSize: 13 }}>
            <X size={14} /> Cancel
          </button>
        )}
      </div>

      {step >= 4 && (
        <p style={{ margin: 0, fontSize: 12, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle2 size={14} /> Wi‑Fi configured — scroll down to <strong>Bind camera to CarPro</strong>, then{' '}
          <strong>Connect &amp; open live feed</strong>.
        </p>
      )}
    </div>
  );
};
