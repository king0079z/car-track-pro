import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Cloud,
  Grid2X2,
  Gauge,
  Loader2,
  QrCode,
  Wifi,
  AlertCircle,
  ArrowRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { camerasApi, visionflowApi, type DahuaHeroA1Public } from '../../services/api';

type Phase = 'idle' | 'saving' | 'cloud' | 'testing' | 'live' | 'done' | 'failed';
type Destination = 'multicam' | 'anpr';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 14,
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function extractApiError(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as {
      message?: string;
      detail?: string;
      hint?: string;
      fixes?: string[];
      cloud_error?: string;
      lan_error?: string;
    };
    const parts = [d.message, d.hint, d.cloud_error, d.lan_error, d.detail].filter(Boolean);
    if (d.fixes?.length) parts.push(...d.fixes);
    return parts.join(' — ');
  }
  return 'Request failed';
}

type Diagnosis = {
  pc_ips: string[];
  camera_host: string;
  subnet_mismatch: boolean;
  lan_rtsp_reachable: boolean;
  fixes: string[];
};

export const DahuaCloudConnect: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [serial, setSerial] = useState('');
  const [lanHost, setLanHost] = useState('10.0.0.13');
  const [password, setPassword] = useState('');
  const [qrText, setQrText] = useState('');
  const [destination, setDestination] = useState<Destination>('multicam');
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusLine, setStatusLine] = useState('');
  const [connectionVia, setConnectionVia] = useState<'cloud' | 'lan' | null>(null);
  const [cloudOnline, setCloudOnline] = useState<boolean | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await camerasApi.getHeroA1();
      const data = res.data as DahuaHeroA1Public;
      const cfg = data.config ?? {};
      setSerial(String(cfg.device_serial || '').trim());
      setLanHost(String(cfg.host || '10.0.0.13').trim());
      setPasswordSaved(Boolean(cfg.password));
      if (cfg.device_serial && cfg.device_type) {
        setQrText(`{SN:${cfg.device_serial},DT:${cfg.device_type},SC:${cfg.security_code || ''}}`);
      }
      try {
        const cloud = await camerasApi.getHeroCloudStatus();
        setCloudOnline(cloud.data.online ?? null);
      } catch {
        setCloudOnline(null);
      }
      try {
        const diag = await camerasApi.diagnoseHeroA1();
        setDiagnosis(diag.data);
      } catch {
        setDiagnosis(null);
      }
    } catch {
      toast.error('Could not load camera settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const scanNetwork = async () => {
    setScanBusy(true);
    try {
      const res = await camerasApi.discoverHeroA1();
      const candidates = res.data.candidates ?? [];
      if (candidates.length > 0) {
        const best = candidates[0].host;
        setLanHost(best);
        toast.success(`Found camera at ${best} — click Connect again`);
      } else {
        toast.error(res.data.hint || 'No Dahua camera found on this Wi‑Fi');
      }
    } catch {
      toast.error('Network scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  const applyQr = async () => {
    const qr = qrText.trim();
    if (!qr) {
      toast.error('Paste the label QR text first');
      return;
    }
    try {
      const res = await camerasApi.parseHeroQr(qr, true);
      const sn = res.data.parsed.serial_number;
      if (sn) setSerial(sn);
      toast.success('Serial saved from QR');
      await loadConfig();
    } catch {
      toast.error('Could not parse QR — use {SN:...,DT:...,SC:...}');
    }
  };

  const pollCloudTunnel = async (maxSec = 90): Promise<boolean> => {
    const deadline = Date.now() + maxSec * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      try {
        const res = await camerasApi.p2pStatus();
        const tunnel = res.data.tunnel;
        if (tunnel.running) return true;
        if (tunnel.phase === 'failed') return false;
        const msg = String(tunnel.phase_message || tunnel.last_error || 'Connecting…');
        setStatusLine(`Cloud tunnel: ${msg} (${tick * 2}s)`);
      } catch {
        /* keep polling */
      }
      tick += 1;
      await sleep(2000);
    }
    return false;
  };

  const connectAndOpenLive = async () => {
    const sn = serial.trim();
    if (!sn) {
      toast.error('Enter serial or apply QR first');
      return;
    }
    const pwd = password.trim();
    const useSaved = passwordSaved && !pwd;
    if (!useSaved && !pwd) {
      toast.error('Enter the device password from DMSS (not the QR security code)');
      return;
    }

    setPhase('saving');
    setStatusLine('Saving camera settings…');
    setConnectionVia(null);

    try {
      await camerasApi.updateHeroA1({
        enabled: true,
        connection_mode: 'auto',
        device_serial: sn,
        host: lanHost.trim(),
        username: 'admin',
        stream: 'sub',
        ...(useSaved ? {} : { password: pwd }),
      });
      if (!useSaved) setPasswordSaved(true);
      setPassword('');

      setPhase('cloud');
      setStatusLine('Starting Easy4IP cloud tunnel (UDP)…');
      await camerasApi.p2pStart(useSaved ? { username: 'admin' } : { username: 'admin', password: pwd });

      const tunnelReady = await pollCloudTunnel(90);
      let via: 'cloud' | 'lan' = tunnelReady ? 'cloud' : 'lan';
      if (tunnelReady) {
        setConnectionVia('cloud');
        setStatusLine('Cloud tunnel ready — verifying video stream…');
      } else {
        setStatusLine('Cloud tunnel unavailable — trying LAN at ' + (lanHost.trim() || 'camera IP') + '…');
      }

      setPhase('testing');
      const testRes = await camerasApi.testHeroA1(useSaved ? {} : { password: pwd });
      if (!testRes.data.ok) {
        setPhase('failed');
        setStatusLine(testRes.data.error || 'Could not open camera video stream');
        toast.error(testRes.data.error || 'Connection failed', { duration: 10000 });
        return;
      }

      const mode = String((testRes.data as { connection_mode?: string }).connection_mode || '');
      if (mode === 'lan' || (testRes.data as { fallback?: string }).fallback) {
        via = 'lan';
      }
      setConnectionVia(via);

      setPhase('live');
      setStatusLine('Starting live ANPR feed…');

      if (destination === 'multicam') {
        const liveRes = await visionflowApi.gridStart(0, 'dahua-hero-a1', true, true);
        if (!liveRes.ok) {
          let detail = 'Could not start live camera';
          try {
            const j = await liveRes.json();
            if (j.detail) detail = typeof j.detail === 'string' ? j.detail : String(j.detail.message || j.detail);
          } catch {
            /* noop */
          }
          setPhase('failed');
          setStatusLine(detail);
          toast.error(detail, { duration: 10000 });
          return;
        }
      }

      setPhase('done');
      setStatusLine('Connected — opening live view…');
      toast.success(
        via === 'cloud'
          ? 'Camera connected via cloud — opening live feed'
          : 'Camera connected via LAN — opening live feed',
        { duration: 5000 },
      );

      await sleep(600);
      if (destination === 'anpr') {
        navigate('/visionflow', {
          state: { fromCloudConnect: true, autostartLive: true, liveSource: 'dahua-hero-a1' },
        });
      } else {
        navigate('/visionflow/multicam', { state: { fromCloudConnect: true, liveStarted: true } });
      }
    } catch (err: unknown) {
      setPhase('failed');
      const msg = extractApiError(err);
      setStatusLine(msg);
      toast.error(msg, { duration: 10000 });
    }
  };

  const busy = phase !== 'idle' && phase !== 'failed' && phase !== 'done';
  const steps = [
    { id: 1, label: 'Credentials', done: Boolean(serial && (passwordSaved || password)) },
    { id: 2, label: 'Cloud + video', done: phase === 'live' || phase === 'done' || connectionVia !== null },
    { id: 3, label: 'Live feed', done: phase === 'done' },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: 'var(--text-muted)' }}>
        <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> Loading camera setup…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div
        style={{
          padding: '16px 18px',
          borderRadius: 14,
          border: '1px solid rgba(59,130,246,0.25)',
          background: 'linear-gradient(135deg, rgba(37,99,235,0.08), rgba(16,185,129,0.06))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(59,130,246,0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Cloud size={22} color="#60a5fa" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text-primary)' }}>
              Connect camera via cloud
            </h3>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, maxWidth: 560 }}>
              One-click setup: save settings, open the Easy4IP tunnel, verify video, then jump to the live feed.
              Uses <strong>admin</strong> + your <strong>DMSS device password</strong> (not the QR security code).
            </p>
            {cloudOnline === true && (
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} /> Camera serial is visible on Dahua cloud
              </p>
            )}
            {cloudOnline === false && (
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertCircle size={14} /> Open DMSS and confirm the camera is online before connecting
              </p>
            )}
            {diagnosis?.subnet_mismatch && (
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#ef4444', lineHeight: 1.5 }}>
                <strong>Network mismatch:</strong> this PC is on {diagnosis.pc_ips.join(', ') || 'unknown'}, but the camera IP is{' '}
                {diagnosis.camera_host}. LAN cannot work until both are on the same Wi‑Fi — update LAN IP from DMSS or click Scan network.
              </p>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {steps.map(s => (
          <div
            key={s.id}
            style={{
              flex: '1 1 120px',
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${s.done ? 'rgba(16,185,129,0.35)' : 'var(--border-light)'}`,
              background: s.done ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)',
              fontSize: 12,
              fontWeight: 700,
              color: s.done ? '#10b981' : 'var(--text-muted)',
            }}
          >
            {s.done ? '✓' : s.id}. {s.label}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Serial (SN)
          </span>
          <input style={inputStyle} value={serial} onChange={e => setSerial(e.target.value.toUpperCase())} placeholder="BF0E4C7GAGB833C" spellCheck={false} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            LAN IP (fallback)
          </span>
          <input style={inputStyle} value={lanHost} onChange={e => setLanHost(e.target.value)} placeholder="10.0.0.13 from DMSS" spellCheck={false} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Device password
          </span>
          <input
            style={inputStyle}
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={passwordSaved ? 'Saved — type only to change' : 'From DMSS device settings'}
            autoComplete="new-password"
          />
          {passwordSaved && !password && (
            <span style={{ fontSize: 11, color: '#10b981' }}>Password saved on server</span>
          )}
        </label>
      </div>

      <div style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border-light)', background: 'var(--bg-elevated)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          Label QR (optional)
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input
            style={{ ...inputStyle, flex: '1 1 280px' }}
            value={qrText}
            onChange={e => setQrText(e.target.value)}
            placeholder="{SN:...,DT:DH-H3A,SC:...}"
            spellCheck={false}
          />
          <button type="button" className="btn btn-secondary" onClick={() => void applyQr()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <QrCode size={14} /> Apply QR
          </button>
        </div>
      </div>

      <div>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          After connect, open
        </span>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="dest" checked={destination === 'multicam'} onChange={() => setDestination('multicam')} />
            <Grid2X2 size={16} /> Camera wall (recommended)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="dest" checked={destination === 'anpr'} onChange={() => setDestination('anpr')} />
            <Gauge size={16} /> ANPR &amp; Speed
          </label>
        </div>
      </div>

      {statusLine && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.5,
            border: `1px solid ${phase === 'failed' ? 'rgba(239,68,68,0.3)' : phase === 'done' ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
            background:
              phase === 'failed'
                ? 'rgba(239,68,68,0.08)'
                : phase === 'done'
                  ? 'rgba(16,185,129,0.08)'
                  : 'rgba(245,158,11,0.08)',
            color: phase === 'failed' ? '#ef4444' : phase === 'done' ? '#10b981' : '#f59e0b',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          {busy ? (
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', flexShrink: 0, marginTop: 2 }} />
          ) : phase === 'done' ? (
            <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          ) : phase === 'failed' ? (
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          ) : (
            <Wifi size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          )}
          <span>{statusLine}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !serial.trim()}
          onClick={() => void connectAndOpenLive()}
          style={{ fontSize: 14, padding: '11px 22px', display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          {busy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Cloud size={16} />}
          Connect &amp; open live feed
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || scanBusy}
          onClick={() => void scanNetwork()}
          style={{ fontSize: 13 }}
        >
          {scanBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
          Scan network for camera
        </button>
        {phase === 'failed' && (
          <button type="button" className="btn btn-secondary" onClick={() => { setPhase('idle'); setStatusLine(''); }} style={{ fontSize: 13 }}>
            Try again
          </button>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Cloud setup can take up to 90 seconds. If UDP is blocked, CarTrack automatically tries your LAN IP when the PC is on the same Wi‑Fi as the camera.
        Advanced options (relay, PTZ) remain under <strong>AI &amp; vision</strong>.
      </p>
    </div>
  );
};
