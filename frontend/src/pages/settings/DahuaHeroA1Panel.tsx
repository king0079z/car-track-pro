import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Loader2,
  Radio,
  QrCode,
  Search,
  Video,
  Wifi,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { DahuaQrScanner } from '../../components/DahuaQrScanner';
import { camerasApi, type DahuaHeroA1Config, type DahuaHeroA1Public, type DahuaQrParseResult } from '../../services/api';

type Props = {
  compact?: boolean;
  onUseAsSource?: (token: string) => void;
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontSize: 13,
  width: '100%',
};

export const DahuaHeroA1Panel: React.FC<Props> = ({ compact = false, onUseAsSource }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [ptzBusy, setPtzBusy] = useState(false);
  const [pub, setPub] = useState<DahuaHeroA1Public | null>(null);
  const [form, setForm] = useState<DahuaHeroA1Config>({
    enabled: false,
    host: '',
    rtsp_port: 554,
    http_port: 80,
    username: 'admin',
    password: '',
    stream: 'sub',
    label: 'Dahua Hero A1',
    use_tcp_transport: true,
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; width?: number; height?: number } | null>(null);
  const [candidates, setCandidates] = useState<Array<{ host: string; confidence: string; likely_model: string }>>([]);
  const [scanMeta, setScanMeta] = useState<{ subnets?: string; checked?: number } | null>(null);
  const [qrText, setQrText] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [qrGuide, setQrGuide] = useState<DahuaQrParseResult | null>(null);
  const [p2pBusy, setP2pBusy] = useState(false);
  const [p2pStatus, setP2pStatus] = useState<Record<string, unknown> | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [cloudProbing, setCloudProbing] = useState(false);
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayStatus, setRelayStatus] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await camerasApi.getHeroA1();
      const data = res.data as DahuaHeroA1Public;
      setPub(data);
      const { password: masked, ...rest } = data.config;
      setForm(f => ({ ...f, ...rest, password: '' }));
      setPasswordSaved(Boolean(masked && masked !== ''));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const isTimeout = (err as { code?: string })?.code === 'ECONNABORTED';
      if (status === 404) {
        setLoadError('Camera API not available — restart deploy.cmd (backend may be stale after an update).');
        toast.error(
          'Camera API not available — close the backend window and run deploy.cmd again (stale server after update).',
          { duration: 6000 },
        );
      } else if (isTimeout) {
        setLoadError('Backend timed out — if cloud P2P is starting, switch to LAN mode or wait and retry.');
        toast.error('Camera settings timed out — try Retry or use LAN (Same Wi-Fi) mode.', { duration: 5000 });
      } else {
        setLoadError('Could not load camera settings — check backend and tunnel are running.');
        toast.error('Could not load Dahua camera settings');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshP2pStatus = useCallback(async () => {
    try {
      const res = await camerasApi.p2pStatus();
      setP2pStatus(res.data.tunnel as Record<string, unknown>);
    } catch {
      setP2pStatus(null);
    }
  }, []);

  const refreshCloudProbe = useCallback(async () => {
    setCloudProbing(true);
    try {
      const [cloudRes, p2pRes] = await Promise.all([
        camerasApi.getHeroCloudStatus(),
        camerasApi.p2pStatus(),
      ]);
      setPub(prev => (prev ? { ...prev, cloud: cloudRes.data } : prev));
      setP2pStatus(p2pRes.data.tunnel as Record<string, unknown>);
    } catch {
      /* keep form usable even if cloud probe fails */
    } finally {
      setCloudProbing(false);
    }
  }, []);

  useEffect(() => {
    if (loading || (form.connection_mode !== 'p2p' && form.connection_mode !== 'auto' && form.connection_mode !== 'cartrack_cloud')) return;
    void refreshP2pStatus();
    if (form.device_serial?.trim()) void refreshCloudProbe();
    const id = window.setInterval(() => {
      void refreshP2pStatus();
    }, 3000);
    return () => window.clearInterval(id);
  }, [loading, form.connection_mode, form.device_serial, refreshP2pStatus, refreshCloudProbe]);

  const extractApiError = (err: unknown): string => {
    const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
      const d = data as { message?: string; detail?: string; hint?: string };
      return [d.message, d.detail, d.hint].filter(Boolean).join(' — ');
    }
    return 'Request failed';
  };

  const pollCloudTunnel = useCallback(async (maxMs = 200000) => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        const res = await camerasApi.p2pStatus();
        const tunnel = res.data.tunnel as Record<string, unknown>;
        setP2pStatus(tunnel);
        if (tunnel.running) return true;
        if (tunnel.phase === 'failed') return false;
        if (tunnel.last_error && String(tunnel.last_error).includes('Timeout occurred')) return false;
        if (tunnel.last_error && String(tunnel.last_error).includes('PTCP')) return false;
      } catch {
        /* keep polling */
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }, []);

  const startCloud = async () => {
    const pwd = (form.password || '').trim();
    const useSavedPassword = passwordSaved && (!pwd || pwd === '********');
    if (!useSavedPassword && (!pwd || pwd === '********')) {
      toast.error('Type the device password from DMSS, click Save camera, then Start cloud tunnel.', { duration: 8000 });
      return;
    }
    setP2pBusy(true);
    try {
      const mode = form.connection_mode === 'auto' ? 'auto' : form.connection_mode === 'cartrack_cloud' ? 'cartrack_cloud' : 'p2p';
      await camerasApi.updateHeroA1({
        connection_mode: mode,
        device_serial: form.device_serial,
        host: form.host,
        username: form.username,
        ...(useSavedPassword ? {} : { password: pwd }),
        enabled: form.enabled,
      });
      const startApi = mode === 'cartrack_cloud' ? camerasApi.cloudTunnelStart : camerasApi.p2pStart;
      const res = await startApi(
        useSavedPassword ? { username: form.username } : { username: form.username, password: pwd },
      );
      setP2pStatus((res.data.status ?? res.data.tunnel) as Record<string, unknown>);
      toast(
        mode === 'cartrack_cloud'
          ? 'CarTrack Cloud connecting — video may take up to 60 seconds…'
          : 'Cloud tunnel starting — UDP setup can take up to 3 minutes…',
        { duration: 5000, icon: '⏳' },
      );
      const ready = await pollCloudTunnel();
      await refreshP2pStatus();
      if (ready) {
        toast.success('Cloud tunnel ready — click Test RTSP');
      } else {
        const phase = String((p2pStatus as { phase?: string } | null)?.phase || '');
        const hint = form.connection_mode === 'auto' && form.host
          ? ` Cloud failed — Auto mode will use LAN at ${form.host} when you Test RTSP or start live ANPR.`
          : ' On the same Wi-Fi, switch to Same Wi-Fi (LAN IP) or Auto mode.';
        toast.error(
          (phase === 'failed' ? 'Cloud tunnel failed (UDP/PTCP blocked on this network).' : 'Cloud tunnel did not finish in time.')
          + hint,
          { duration: 12000 },
        );
      }
    } catch (err: unknown) {
      toast.error(extractApiError(err), { duration: 8000 });
    } finally {
      setP2pBusy(false);
    }
  };

  const stopCloud = async () => {
    setP2pBusy(true);
    try {
      await camerasApi.p2pStop();
      await refreshP2pStatus();
      toast.success('Cloud tunnel stopped');
    } catch {
      toast.error('Stop failed');
    } finally {
      setP2pBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await camerasApi.updateHeroA1(form);
      const data = res.data as DahuaHeroA1Public;
      setPub(data);
      const pwdOk = Boolean(form.password) || Boolean(data.config?.password);
      setPasswordSaved(pwdOk);
      setForm(f => ({ ...f, password: '' }));
      toast.success('Camera settings saved');
      if ((form.connection_mode === 'p2p' || form.connection_mode === 'auto' || form.connection_mode === 'cartrack_cloud') && form.device_serial && pwdOk) {
        toast('Cloud tunnel starting — wait up to 3 minutes for UDP setup.', { duration: 5000, icon: '⏳' });
        void startCloud();
      }
    } catch {
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await camerasApi.testHeroA1({
        username: form.username,
        password: form.password || undefined,
        rtsp_port: form.rtsp_port,
        stream: form.stream,
        use_tcp_transport: form.use_tcp_transport,
      });
      setTestResult(res.data);
      const fb = (res.data as { fallback?: string }).fallback;
      if (res.data.ok) {
        toast.success(fb || `Stream OK — ${res.data.width}×${res.data.height}`);
        if (fb) setForm(f => ({ ...f, connection_mode: 'lan' }));
      } else toast.error(res.data.error || 'Connection failed');
    } catch (err: unknown) {
      toast.error(extractApiError(err), { duration: 8000 });
    } finally {
      setTesting(false);
    }
  };

  const applyQr = async (raw?: string) => {
    const qr = (raw ?? qrText).trim();
    if (!qr) {
      toast.error('Paste the text from your camera QR label');
      return;
    }
    if (raw) setQrText(raw);
    setQrBusy(true);
    try {
      const res = await camerasApi.parseHeroQr(qr, true);
      setQrGuide(res.data);
      if (res.data.public) {
        setPub(res.data.public);
        const { password: _m, ...rest } = res.data.public!.config;
        setForm(f => ({ ...f, ...rest, password: '' }));
        setPasswordSaved(Boolean(_m));
      } else if (res.data.suggested_config) {
        setForm(f => ({ ...f, ...res.data.suggested_config }));
      }
      toast.success(`Registered ${res.data.parsed.device_type || 'camera'} — complete Wi-Fi in DMSS, then set IP here`);
    } catch {
      toast.error('Could not parse QR — use format {SN:...,DT:...,SC:...}');
    } finally {
      setQrBusy(false);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    setScanMeta(null);
    try {
      const res = await camerasApi.discoverHeroA1();
      setCandidates(res.data.candidates ?? []);
      const subnets = res.data.scanned_subnets?.join(', ');
      const checked = res.data.hosts_checked;
      setScanMeta(subnets ? { subnets, checked } : null);
      if (res.data.candidates?.length) {
        toast.success(`Found ${res.data.candidates.length} device(s) on LAN`);
      } else {
        toast(res.data.hint || 'No cameras found — confirm same Wi-Fi and IP in DMSS', { icon: 'ℹ️', duration: 7000 });
      }
    } catch (err: unknown) {
      const msg = (err as { code?: string; message?: string })?.code === 'ECONNABORTED'
        ? 'Scan timed out — enter camera IP from DMSS manually'
        : 'Network scan failed — restart backend and try again';
      toast.error(msg, { duration: 7000 });
    } finally {
      setDiscovering(false);
    }
  };

  const ptz = async (direction: string) => {
    setPtzBusy(true);
    try {
      const res = await camerasApi.ptzHeroA1(direction);
      if (res.data?.ok) toast.success('PTZ command sent');
      else toast.error((res.data as { error?: string })?.error || 'PTZ not available — use DMSS app');
    } catch {
      toast.error('PTZ request failed');
    } finally {
      setPtzBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading camera profile…
      </div>
    );
  }

  if (loadError && !pub) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f87171', fontSize: 13 }}>
          <AlertCircle size={16} /> {loadError}
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} style={{ alignSelf: 'flex-start' }}>
          Retry
        </button>
      </div>
    );
  }

  const token = pub?.source_token ?? 'dahua-hero-a1';
  const configured = pub?.configured;

  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid rgba(59,130,246,0.25)',
      background: 'linear-gradient(135deg, rgba(37,99,235,0.06), rgba(16,185,129,0.04))',
      padding: compact ? '16px 18px' : '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Video size={20} color="#3b82f6" />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {form.label || pub?.profile.model || pub?.profile.name || 'Dahua Wi-Fi Camera'}
          </div>
          {pub?.profile.model && form.label !== pub.profile.model && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {pub.profile.name}
            </div>
          )}
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, maxWidth: 680 }}>
            {pub?.profile.usb_note ?? 'USB-C is power only. Video uses Wi-Fi RTSP on your LAN.'}
            {' '}Configure the camera in the <strong>DMSS</strong> app first, then enter its IP below.
          </p>
        </div>
        {configured && (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 99,
            background: 'rgba(16,185,129,0.12)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            <CheckCircle2 size={12} /> Ready · source <code style={{ fontSize: 10 }}>{token}</code>
          </span>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} style={{ accentColor: '#3b82f6' }} />
        Enable {pub?.profile.model ?? 'Dahua'} camera for live ANPR
      </label>

      {pub?.env_configured && (
        <p style={{ margin: 0, fontSize: 11, color: '#10b981', lineHeight: 1.5 }}>
          Cloud camera settings loaded from server environment (<code>DAHUA_*</code>) — Easy4IP P2P starts automatically on boot.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', width: '100%' }}>
          Connection
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="dahua-conn"
            checked={(form.connection_mode ?? 'lan') === 'lan'}
            onChange={() => setForm(f => ({ ...f, connection_mode: 'lan' }))}
          />
          Same Wi-Fi (LAN IP)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="dahua-conn"
            checked={form.connection_mode === 'cartrack_cloud'}
            onChange={() => setForm(f => ({ ...f, connection_mode: 'cartrack_cloud' }))}
          />
          CarTrack Cloud (remote, no shop PC) — recommended
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="dahua-conn"
            checked={form.connection_mode === 'auto'}
            onChange={() => setForm(f => ({ ...f, connection_mode: 'auto' }))}
          />
          Auto (legacy cloud, then LAN)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="dahua-conn"
            checked={form.connection_mode === 'cartrack_relay'}
            onChange={() => setForm(f => ({ ...f, connection_mode: 'cartrack_relay' }))}
          />
          Site relay (shop PC → your VPS)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="dahua-conn"
            checked={form.connection_mode === 'p2p'}
            onChange={() => setForm(f => ({ ...f, connection_mode: 'p2p' }))}
          />
          Dahua cloud only (P2P)
        </label>
      </div>

      {form.connection_mode === 'cartrack_relay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Uses <strong>your</strong> media server (VPS + MediaMTX), not Dahua Easy4IP. A PC on the same Wi-Fi as the camera
            forwards LAN RTSP to your server; remote CarTrack reads from the view URL.
          </p>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Publish URL (site PC → your server)
            <input
              style={{ ...inputStyle, marginTop: 4 }}
              placeholder="rtsp://your-vps:8554/site/cam"
              value={form.cartrack_relay_publish_url ?? ''}
              onChange={e => setForm(f => ({ ...f, cartrack_relay_publish_url: e.target.value }))}
            />
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            View URL (cloud CarTrack reads this)
            <input
              style={{ ...inputStyle, marginTop: 4 }}
              placeholder="rtsp://your-vps:8554/site/cam"
              value={form.cartrack_relay_view_url ?? ''}
              onChange={e => setForm(f => ({ ...f, cartrack_relay_view_url: e.target.value }))}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 13 }}
              disabled={relayBusy || !form.host}
              onClick={async () => {
                setRelayBusy(true);
                try {
                  await camerasApi.updateHeroA1(form);
                  const res = await camerasApi.cartrackRelayStart();
                  setRelayStatus(res.data as Record<string, unknown>);
                  toast.success('CarTrack relay publishing LAN stream');
                } catch (err: unknown) {
                  toast.error(extractApiError(err), { duration: 8000 });
                } finally {
                  setRelayBusy(false);
                }
              }}
            >
              {relayBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              Start CarTrack relay
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 13 }}
              disabled={relayBusy}
              onClick={async () => {
                setRelayBusy(true);
                try {
                  await camerasApi.cartrackRelayStop();
                  const res = await camerasApi.cartrackRelayStatus();
                  setRelayStatus(res.data.relay as Record<string, unknown>);
                  toast.success('Relay stopped');
                } catch {
                  toast.error('Stop failed');
                } finally {
                  setRelayBusy(false);
                }
              }}
            >
              Stop relay
            </button>
          </div>
          {relayStatus?.running ? (
            <span style={{ fontSize: 11, color: '#10b981' }}>Relay running — stream is on your server</span>
          ) : null}
          <p style={{ margin: 0, fontSize: 11, color: '#f59e0b' }}>
            See <code style={{ fontSize: 11 }}>docs/cartrack-cloud-video.md</code> for MediaMTX setup on a VPS.
          </p>
        </div>
      )}

      {(form.connection_mode === 'cartrack_cloud' || form.connection_mode === 'p2p' || form.connection_mode === 'auto') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {form.connection_mode === 'cartrack_cloud' && (
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)', width: '100%', lineHeight: 1.55 }}>
              <strong>CarTrack Cloud</strong> connects your VPS to the camera remotely — no Imou app and no PC at the shop.
              Enter serial + device password, save, then connect. Close live view in Imou/DMSS on phones (one stream at a time).
            </p>
          )}
          <button type="button" className="btn btn-secondary" disabled={p2pBusy || !form.device_serial} onClick={() => void startCloud()} style={{ fontSize: 13 }}>
            {p2pBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            {form.connection_mode === 'cartrack_cloud' ? 'Connect CarTrack Cloud' : 'Start cloud tunnel'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={p2pBusy} onClick={() => void stopCloud()} style={{ fontSize: 13 }}>
            Stop tunnel
          </button>
          {p2pStatus?.running ? (
            <span style={{ fontSize: 11, color: '#10b981' }}>
              {form.connection_mode === 'cartrack_cloud' ? 'CarTrack Cloud connected' : 'Cloud tunnel ready'} on port {String(p2pStatus.local_port ?? 18554)}
            </span>
          ) : p2pBusy || (p2pStatus?.phase && p2pStatus.phase !== 'idle' && p2pStatus.phase !== 'failed') ? (
            <span style={{ fontSize: 11, color: '#f59e0b' }}>
              {String(p2pStatus?.phase_message || 'Cloud tunnel connecting…')}
              {p2pBusy ? ' (please wait)' : ''}
            </span>
          ) : p2pStatus?.phase === 'failed' ? (
            <span style={{ fontSize: 11, color: '#ef4444', maxWidth: '100%' }}>
              {String(p2pStatus?.phase_message || p2pStatus?.last_error || 'Cloud tunnel failed')}
            </span>
          ) : null}
          <p style={{ margin: 0, fontSize: 11, color: '#10b981', width: '100%' }}>
            <strong>LAN works at {form.host || '192.168.1.132'}?</strong> Keep <strong>Same Wi-Fi (LAN IP)</strong> on site — fastest and most reliable for live ANPR.
          </p>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)', width: '100%', lineHeight: 1.55 }}>
            Same protocol as DMSS: CarTrack talks to <strong>Easy4IP cloud</strong> with your camera serial, then uses <strong>admin</strong> + the
            <strong> device password</strong> from DMSS (not your DMSS email login). Log in on the DMSS app first so the camera is bound and online.
          </p>
          {cloudProbing && (
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', width: '100%' }}>
              Checking Dahua cloud…
            </p>
          )}
          {!cloudProbing && pub?.cloud?.online === false && pub?.cloud?.deps_ok !== false && (
            <p style={{ margin: 0, fontSize: 11, color: '#ef4444', width: '100%' }}>
              Camera not visible on Dahua cloud yet — open DMSS, confirm the device is online, then retry Start cloud tunnel.
            </p>
          )}
          {!cloudProbing && pub?.cloud?.online && !p2pStatus?.running && (
            <p style={{ margin: 0, fontSize: 11, color: '#10b981', width: '100%' }}>
              Serial registered on Dahua cloud (Easy4IP). That is <strong>not</strong> the same as a working tunnel — click
              Start cloud tunnel and wait for <strong>Cloud tunnel ready</strong> (UDP). Many networks block this; LAN mode is more reliable.
            </p>
          )}
          {form.host && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 12 }}
              disabled={saving || p2pBusy}
              onClick={() => {
                setForm(f => ({ ...f, connection_mode: 'lan' }));
                toast('Switched to Same Wi-Fi (LAN IP) — click Save camera', { icon: 'ℹ️' });
              }}
            >
              Use Same Wi-Fi (LAN) at {form.host} instead
            </button>
          )}
          <p style={{ margin: 0, fontSize: 11, color: '#f59e0b', width: '100%' }}>
            If cloud fails but LAN works, reset <strong>device password</strong> in DMSS → Settings, Save here, then Start cloud tunnel again.
          </p>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', width: '100%' }}>
            <strong>Auto</strong> tries cloud for ~40s, then uses LAN IP ({form.host || 'set IP below'}) on the same Wi-Fi — best for live ANPR.
            Cloud-only needs UDP through your router (often blocked).
          </p>
        </div>
      )}

      <div style={{
        padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border-light)',
        background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          Label QR (SN / model / security code)
        </span>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Paste what you read from the sticker. This registers your camera in CarTrack and is used with DMSS for Wi-Fi setup.
          The security code is <strong>not</strong> the RTSP password.
        </p>
        <input
          style={inputStyle}
          value={qrText}
          onChange={e => setQrText(e.target.value)}
          placeholder="{SN:BF0E4C7GAGB833C,DT:DH-H3A,SC:L219E7D3}"
          spellCheck={false}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setQrScannerOpen(true)}
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <QrCode size={14} /> Scan QR label
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={qrBusy || !qrText.trim()}
            onClick={() => void applyQr()}
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {qrBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <QrCode size={14} />}
            Apply QR to setup
          </button>
        </div>
        {form.device_serial && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Serial {form.device_serial}
            {form.device_type ? ` · ${form.device_type}` : ''}
          </span>
        )}
        {qrGuide && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            <p style={{ margin: '0 0 6px', color: '#f59e0b' }}>{qrGuide.important}</p>
            <strong>DMSS:</strong>
            <ol style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
              {qrGuide.dmss_steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <strong>CarTrack:</strong>
            <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {qrGuide.cartrack_steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Camera IP / hostname {form.connection_mode === 'p2p' ? '(LAN fallback)' : ''}
          </span>
          <input style={inputStyle} value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="10.0.0.13 from DMSS" spellCheck={false} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Username</span>
          <input style={inputStyle} value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="admin" autoComplete="off" />
          {form.username.includes('@') && (
            <span style={{ fontSize: 11, color: '#f59e0b' }}>Use admin — RTSP does not use your DMSS email.</span>
          )}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Password</span>
          <input
            style={inputStyle}
            type="password"
            value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder={passwordSaved && !form.password ? 'Saved — type only to change' : 'Device password from DMSS'}
            autoComplete="new-password"
          />
          {passwordSaved && !form.password && (
            <span style={{ fontSize: 11, color: '#10b981' }}>Password saved on server (Test RTSP uses it).</span>
          )}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Stream</span>
          <select style={inputStyle} value={form.stream} onChange={e => setForm(f => ({ ...f, stream: e.target.value as 'main' | 'sub' }))}>
            <option value="sub">Sub stream (recommended — lower latency)</option>
            <option value="main">Main stream (full quality)</option>
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
          Save camera
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={testing || (form.connection_mode === 'p2p' ? !form.device_serial : !form.host)}
          onClick={() => void testConnection()}
          style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {testing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Wifi size={14} />}
          Test RTSP
        </button>
        <button type="button" className="btn btn-secondary" disabled={discovering} onClick={() => void discover()} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {discovering ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={14} />}
          Scan network
        </button>
        {onUseAsSource && configured && (
          <button type="button" className="btn btn-secondary" onClick={() => onUseAsSource(token)} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Radio size={14} /> Use for live tracking
          </button>
        )}
      </div>

      {testResult && (
        <div style={{
          fontSize: 12, padding: '10px 12px', borderRadius: 10,
          border: `1px solid ${testResult.ok ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
          background: testResult.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
          color: testResult.ok ? '#10b981' : '#ef4444',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {testResult.ok ? <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />}
            <span>
              {testResult.ok
                ? `Connected — ${testResult.width}×${testResult.height} @ RTSP`
                : (testResult.error || 'Connection failed')}
            </span>
          </div>
        </div>
      )}

      {scanMeta && (
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          Scanned {scanMeta.checked ?? '?'} addresses on {scanMeta.subnets}
        </p>
      )}

      {candidates.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          <strong>Found on LAN:</strong>{' '}
          {candidates.map(c => (
            <button
              key={c.host}
              type="button"
              onClick={() => setForm(f => ({ ...f, host: c.host, enabled: true }))}
              style={{
                margin: '4px 6px 0 0', padding: '4px 10px', borderRadius: 8, cursor: 'pointer',
                border: '1px solid var(--border-light)', background: 'var(--bg-elevated)', fontSize: 11,
              }}
            >
              {c.host} ({c.likely_model})
            </button>
          ))}
        </div>
      )}

      {!compact && configured && (
        <div style={{ marginTop: 4, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Pan / tilt ({pub?.profile.model ?? 'camera'})</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {([
              ['up', ArrowUp],
              ['down', ArrowDown],
              ['left', ArrowLeft],
              ['right', ArrowRight],
            ] as const).map(([dir, Icon]) => (
              <button key={dir} type="button" className="btn btn-secondary" disabled={ptzBusy} onClick={() => void ptz(dir)} style={{ padding: '8px 12px' }}>
                <Icon size={16} />
              </button>
            ))}
          </div>
        </div>
      )}

      <DahuaQrScanner
        open={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
        onScan={raw => void applyQr(raw)}
      />
    </div>
  );
};
