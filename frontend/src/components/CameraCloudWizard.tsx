import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Gauge,
  Grid2X2,
  Home,
  Loader2,
  QrCode,
  Radio,
  Router,
  Sparkles,
  Wifi,
  Zap,
  AlertCircle,
  Building2,
  Smartphone,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { DahuaQrScanner } from './DahuaQrScanner';
import { camerasApi, visionflowApi, type DahuaHeroA1Public } from '../services/api';
import {
  browserConnectWifi,
  browserProbeAnyHost,
  browserScanWifi,
  DEFAULT_CAMERA_HOSTS,
  type LocalWifiNetwork,
} from '../services/dahuaLocalSetup';

type Scenario = 'new' | 'online' | 'onsite' | 'relocate';
type ConnectionMethod = 'cartrack_cloud' | 'cloud_hls' | 'lan';
type StepId = 'start' | 'identify' | 'wifi' | 'method' | 'connect' | 'success';
type Destination = 'multicam' | 'anpr';
type ConnectPhase = 'idle' | 'save' | 'tunnel' | 'test' | 'live' | 'done' | 'failed';

const SCENARIOS: {
  id: Scenario;
  title: string;
  desc: string;
  icon: React.ReactNode;
  badge?: string;
}[] = [
  {
    id: 'new',
    title: 'Brand-new camera',
    desc: 'Still in the box or never connected to shop Wi‑Fi. We’ll guide Wi‑Fi setup first.',
    icon: <Sparkles size={28} />,
    badge: 'First install',
  },
  {
    id: 'relocate',
    title: 'Moving to new Wi‑Fi',
    desc: 'New shop or router. Remote switch if still online, or on-site hotspot setup.',
    icon: <Wifi size={28} />,
    badge: 'Relocate',
  },
  {
    id: 'online',
    title: 'Already on Wi‑Fi',
    desc: 'Camera was set up before (DMSS / Imou / CarTrack). Connect remotely from anywhere.',
    icon: <Cloud size={28} />,
    badge: 'Most common',
  },
  {
    id: 'onsite',
    title: 'At the shop now',
    desc: 'This device is on the same network as the camera. Direct LAN connection.',
    icon: <Building2 size={28} />,
  },
];

const METHODS: {
  id: ConnectionMethod;
  title: string;
  desc: string;
  pros: string[];
  icon: React.ReactNode;
  badge?: string;
  hideFor?: Scenario[];
  advanced?: boolean;
}[] = [
  {
    id: 'cartrack_cloud',
    title: 'CarTrack Cloud',
    desc: 'Same remote path as DMSS (P2P relay) — no Imou developer API, no monthly quota.',
    pros: ['Works from anywhere', 'No Imou bind or OP1013', 'Best for VPS + 24/7 ANPR'],
    icon: <Zap size={24} />,
    badge: 'Recommended',
  },
  {
    id: 'cloud_hls',
    title: 'Imou developer app',
    desc: 'Metered Open Platform API (~30k calls/month). Use only for remote Wi‑Fi switch or HLS experiments.',
    pros: ['Remote Wi‑Fi from Settings', 'Official Imou REST API', 'Uses API quota — not like DMSS'],
    icon: <Cloud size={24} />,
    hideFor: ['onsite'],
    advanced: true,
  },
  {
    id: 'lan',
    title: 'Shop LAN',
    desc: 'Direct RTSP when you’re on the same Wi‑Fi as the camera.',
    pros: ['Lowest latency', 'Most reliable on-site', 'No cloud quota'],
    icon: <Router size={24} />,
    hideFor: ['online'],
  },
];

function stepsFor(scenario: Scenario): StepId[] {
  if (scenario === 'new' || scenario === 'relocate') return ['start', 'identify', 'wifi', 'method', 'connect', 'success'];
  if (scenario === 'onsite') return ['start', 'identify', 'method', 'connect', 'success'];
  return ['start', 'identify', 'method', 'connect', 'success'];
}

const STEP_LABELS: Record<StepId, string> = {
  start: 'Start',
  identify: 'Camera',
  wifi: 'Wi‑Fi',
  method: 'Connection',
  connect: 'Connect',
  success: 'Done',
};

function extractApiError(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { message?: string; hint?: string; detail?: string; fixes?: string[] };
    return [d.message, d.hint, d.detail, ...(d.fixes ?? [])].filter(Boolean).join(' — ');
  }
  return 'Request failed';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Diagnosis = {
  remote_server?: boolean;
  pc_ips?: string[];
  camera_host?: string;
  subnet_mismatch?: boolean;
};

export const CameraCloudWizard: React.FC = () => {
  const navigate = useNavigate();
  const connectStarted = useRef(false);

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<StepId>('start');
  const [scenario, setScenario] = useState<Scenario>('online');
  const [method, setMethod] = useState<ConnectionMethod>('cartrack_cloud');
  const [showAdvancedMethods, setShowAdvancedMethods] = useState(false);
  const [destination, setDestination] = useState<Destination>('multicam');

  const [serial, setSerial] = useState('');
  const [securityCode, setSecurityCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [lanHost, setLanHost] = useState('');
  const [qrText, setQrText] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [imouBound, setImouBound] = useState<boolean | null>(null);
  const [cloudOnline, setCloudOnline] = useState<boolean | null>(null);

  // Wi‑Fi sub-step
  const [camHost, setCamHost] = useState('192.168.1.108');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiNets, setWifiNets] = useState<LocalWifiNetwork[]>([]);
  const [wifiBusy, setWifiBusy] = useState('');

  // Connect progress
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>('idle');
  const [statusLine, setStatusLine] = useState('');
  const [connectionVia, setConnectionVia] = useState<'cloud' | 'lan' | null>(null);

  const stepList = useMemo(() => stepsFor(scenario), [scenario]);
  const currentIdx = stepList.indexOf(step);
  const progress = step === 'success' ? 100 : ((currentIdx + 1) / stepList.length) * 100;
  const remoteServer = diagnosis?.remote_server ?? true;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await camerasApi.getHeroA1();
      const cfg = (res.data as DahuaHeroA1Public).config ?? {};
      setSerial(String(cfg.device_serial || '').trim());
      setLanHost(String(cfg.host || '').trim());
      setPasswordSaved(Boolean(cfg.password));
      setSecurityCode(String(cfg.security_code || ''));
      if (cfg.device_serial) {
        setQrText(`{SN:${cfg.device_serial},DT:${cfg.device_type || 'DH-H3A'},SC:${cfg.security_code || ''}}`);
      }
      const mode = String(cfg.connection_mode || '');
      if (mode === 'lan') {
        setMethod('lan');
        setShowAdvancedMethods(false);
      } else if (mode === 'cloud_hls') {
        setMethod('cloud_hls');
        setShowAdvancedMethods(true);
      } else {
        setMethod('cartrack_cloud');
        setShowAdvancedMethods(false);
      }
    } catch {
      toast.error('Could not load camera settings');
    } finally {
      setLoading(false);
    }
    void (async () => {
      try {
        const d = await camerasApi.diagnoseHeroA1();
        setDiagnosis(d.data);
      } catch {
        setDiagnosis(null);
      }
      try {
        const c = await camerasApi.getHeroCloudStatus();
        setCloudOnline(c.data.online ?? null);
      } catch {
        setCloudOnline(null);
      }
      try {
        const imou = await camerasApi.imouBindStatus();
        setImouBound(Boolean(imou.data.bound?.isMine));
      } catch {
        setImouBound(null);
      }
    })();
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (scenario === 'onsite') setMethod('lan');
    else if (scenario === 'online' && method === 'lan') setMethod('cartrack_cloud');
  }, [scenario, method]);

  const goTo = (id: StepId) => {
    setError(null);
    setStep(id);
    if (id !== 'connect') connectStarted.current = false;
  };

  const goNext = () => {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const idx = stepList.indexOf(step);
    if (idx < stepList.length - 1) goTo(stepList[idx + 1]);
  };

  const goBack = () => {
    setError(null);
    const idx = stepList.indexOf(step);
    if (idx > 0) goTo(stepList[idx - 1]);
  };

  const validateStep = (id: StepId): string | null => {
    if (id === 'identify') {
      if (!serial.trim()) return 'Enter the camera serial from the label or scan the QR code.';
      const pwd = password.trim();
      if (!passwordSaved && !pwd) return 'Enter the device password (from DMSS setup — not the QR security code).';
    }
    if (id === 'wifi') {
      if (!wifiSsid.trim()) return 'Enter or select your shop Wi‑Fi name.';
    }
    if (id === 'method' && !method) return 'Choose how CarTrack should reach your camera.';
    return null;
  };

  const applyQr = async (raw?: string) => {
    const qr = (raw ?? qrText).trim();
    if (!qr) return;
    if (raw) setQrText(raw);
    try {
      const res = await camerasApi.parseHeroQr(qr, true);
      const sn = res.data.parsed.serial_number;
      if (sn) setSerial(sn);
      toast.success('Serial saved from QR');
      await loadConfig();
    } catch {
      toast.error('Could not parse QR');
    }
  };

  const pollTunnel = async (maxSec = 60): Promise<boolean> => {
    const deadline = Date.now() + maxSec * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      try {
        const res = await camerasApi.cloudTunnelStatus();
        const t = res.data.tunnel as Record<string, unknown>;
        const ph = String(t.phase || '');
        if (Boolean(t.p2p_ready) || ph === 'ready') return true;
        const err = String(t.last_error || '');
        if (ph === 'failed' || ph === 'error' || err.includes('404') || err.includes('DEVICE_OFFLINE')) return false;
        setStatusLine(`Cloud tunnel: ${String(t.phase_message || ph || 'Connecting…')} (${tick * 2}s)`);
      } catch {
        /* retry */
      }
      tick += 1;
      await sleep(2000);
    }
    return false;
  };

  const runConnect = useCallback(async () => {
    const sn = serial.trim();
    const pwd = password.trim();
    const useSaved = passwordSaved && !pwd;
    if (!sn || (!useSaved && !pwd)) {
      setConnectPhase('failed');
      setError('Serial and device password are required.');
      return;
    }

    setConnectPhase('save');
    setStatusLine('Saving camera settings…');
    setConnectionVia(null);

    try {
      const cloudMode = method === 'cloud_hls' ? 'cloud_hls' : method === 'lan' ? 'lan' : 'cartrack_cloud';
      await camerasApi.updateHeroA1({
        enabled: true,
        connection_mode: cloudMode,
        device_serial: sn,
        host: lanHost.trim() || undefined,
        username: 'admin',
        stream: 'main',
        ...(useSaved ? {} : { password: pwd }),
      });
      if (!useSaved) setPasswordSaved(true);
      setPassword('');

      let skipImouBind = imouBound === true;
      if (method === 'cloud_hls') {
        try {
          const imou = await camerasApi.imouBindStatus();
          skipImouBind = Boolean(imou.data.bound?.isMine);
          setImouBound(skipImouBind);
        } catch {
          /* use cached status */
        }
        if (!skipImouBind) {
          setConnectPhase('tunnel');
          setStatusLine('Binding to Imou developer app…');
          try {
            const bind = await camerasApi.imouBindHeroA1(useSaved ? {} : { password: pwd });
            setImouBound(Boolean(bind.data.bind?.mine ?? bind.data.bind?.bound));
          } catch (err: unknown) {
            throw new Error(extractApiError(err));
          }
        }
      }

      if (cloudMode === 'cartrack_cloud') {
        setConnectPhase('tunnel');
        setStatusLine('Starting CarTrack Cloud tunnel…');
        try {
          await camerasApi.cloudTunnelStart(useSaved ? { username: 'admin' } : { username: 'admin', password: pwd });
        } catch (err: unknown) {
          throw new Error(extractApiError(err));
        }
        const ready = await pollTunnel(60);
        if (!ready) {
          throw new Error(
            'Camera is offline in Dahua cloud. Finish Wi‑Fi setup, wait 1–2 min, close DMSS on phones, then try again.',
          );
        }
        setConnectionVia('cloud');
      } else if (cloudMode === 'cloud_hls') {
        setConnectPhase('tunnel');
        setConnectionVia('cloud');
        setStatusLine(skipImouBind ? 'Imou already linked — opening cloud stream…' : 'Using Imou cloud stream…');
      } else {
        setConnectionVia('lan');
        setStatusLine('Using shop LAN…');
      }

      setConnectPhase('test');
      setStatusLine('Verifying video stream…');
      const testRes = await camerasApi.testHeroA1({
        connection_mode: cloudMode,
        ...(useSaved ? {} : { password: pwd }),
      });
      if (!testRes.data.ok) throw new Error(testRes.data.error || 'Could not open video stream');

      const mode = String((testRes.data as { connection_mode?: string }).connection_mode || '');
      if (mode === 'lan') setConnectionVia('lan');

      setConnectPhase('live');
      setStatusLine('Starting live feed…');
      try {
        await camerasApi.connect('hero-a1');
      } catch {
        /* optional */
      }

      if (destination === 'multicam') {
        try {
          const liveRes = await visionflowApi.gridStart(0, 'dahua-hero-a1', true, true);
          if (!liveRes.ok) {
            let detail = `Live grid start failed (${liveRes.status})`;
            try {
              const j = await liveRes.json();
              if (j.detail) detail = typeof j.detail === 'string' ? j.detail : String(j.detail.message || j.detail);
            } catch {
              /* noop */
            }
            toast.error(`${detail}. Open Camera wall and tap Refresh.`, { duration: 10000 });
          }
        } catch {
          toast.error('Live grid will start from Camera wall — open it and tap Refresh.', { duration: 10000 });
        }
      }

      setConnectPhase('done');
      setStatusLine('Connected successfully');
      toast.success('Camera connected — opening live view');
      await sleep(500);
      goTo('success');
    } catch (err: unknown) {
      setConnectPhase('failed');
      const msg = err instanceof Error ? err.message : extractApiError(err);
      setStatusLine(msg);
      setError(msg);
      toast.error(msg, { duration: 12000 });
    }
  }, [serial, password, passwordSaved, method, lanHost, imouBound, destination]);

  useEffect(() => {
    if (step === 'connect' && !connectStarted.current) {
      connectStarted.current = true;
      void runConnect();
    }
  }, [step, runConnect]);

  const discoverCam = async () => {
    setWifiBusy('discover');
    try {
      const br = await browserProbeAnyHost([camHost, ...DEFAULT_CAMERA_HOSTS.filter(h => h !== camHost)], password);
      if (br.ok && br.host) {
        setCamHost(br.host);
        if (br.serial) setSerial(br.serial);
        toast.success(`Camera found at ${br.host}`);
        return;
      }
      if (!remoteServer) {
        const { data } = await camerasApi.localSetupDiscover();
        const cam = data.cameras?.[0];
        if (cam?.host) {
          setCamHost(String(cam.host));
          if (cam.serial) setSerial(String(cam.serial));
          toast.success(`Camera found at ${cam.host}`);
          return;
        }
      }
      toast.error('Join camera hotspot Dahua_XXXX (192.168.1.108) on this device, then try again.', { duration: 10000 });
    } finally {
      setWifiBusy('');
    }
  };

  const scanWifi = async () => {
    setWifiBusy('scan');
    setWifiNets([]);
    try {
      const br = await browserScanWifi(camHost, password);
      let nets = br.ok ? br.networks : [];
      if (!nets.length && !remoteServer) {
        const { data } = await camerasApi.localSetupWifiScan({ host: camHost, password, username: 'admin' });
        if (data.ok) nets = data.networks ?? [];
      }
      setWifiNets(nets);
      if (!nets.length) toast('Type your shop Wi‑Fi name manually', { icon: 'i' });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setWifiBusy('');
    }
  };

  const sendWifi = async () => {
    if (!wifiSsid.trim()) {
      setError('Enter shop Wi‑Fi name');
      return;
    }
    setWifiBusy('connect');
    try {
      let ok = false;
      const br = await browserConnectWifi(camHost, wifiSsid.trim(), wifiPassword, password);
      ok = br.ok;
      if (!ok && !remoteServer) {
        const { data } = await camerasApi.localSetupWifiConnect({
          host: camHost,
          ssid: wifiSsid.trim(),
          wifi_password: wifiPassword,
          device_password: password,
        });
        ok = data.ok;
      }
      if (!ok) throw new Error('Could not reach camera — join Dahua_XXXX hotspot on this phone/PC.');
      toast.success('Wi‑Fi sent — wait 1–2 min for camera to reboot', { duration: 8000 });
      goNext();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Wi‑Fi setup failed');
    } finally {
      setWifiBusy('');
    }
  };

  const openLive = () => {
    if (destination === 'anpr') {
      navigate('/visionflow', { state: { fromCloudConnect: true, autostartLive: true, liveSource: 'dahua-hero-a1' } });
    } else {
      navigate('/visionflow/multicam', { state: { fromCloudConnect: true, liveStarted: true } });
    }
  };

  const visibleMethods = METHODS.filter(m => !m.hideFor?.includes(scenario));
  const primaryMethods = visibleMethods.filter(m => !m.advanced);
  const advancedMethods = visibleMethods.filter(m => m.advanced);

  const pickMethod = (id: ConnectionMethod) => {
    setMethod(id);
    if (id === 'cloud_hls') setShowAdvancedMethods(true);
  };

  const toggleAdvancedMethods = () => {
    setShowAdvancedMethods(open => {
      const next = !open;
      if (!next && method === 'cloud_hls') setMethod('cartrack_cloud');
      return next;
    });
  };

  if (loading) {
    return (
      <div className="cc-wizard cc-wizard-loading">
        <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Loading camera wizard…</span>
      </div>
    );
  }

  return (
    <div className="cc-wizard animate-fade-in">
      <header className="cc-wizard-hero">
        <div className="cc-wizard-hero-glow" aria-hidden="true" />
        <div className="cc-wizard-hero-inner">
          <div className="cc-wizard-hero-icon">
            <Cloud size={26} />
          </div>
          <div>
            <h2 className="cc-wizard-title">Camera Cloud Setup</h2>
            <p className="cc-wizard-subtitle">
              Step-by-step guide — pick your situation, connect once, open live video.
            </p>
          </div>
          {cloudOnline === true && (
            <span className="cc-wizard-badge ok">
              <CheckCircle2 size={14} /> Camera online
            </span>
          )}
          {imouBound && (
            <span className="cc-wizard-badge ok">
              <CheckCircle2 size={14} /> Imou linked
            </span>
          )}
        </div>
      </header>

      <div className="cc-wizard-progress-wrap">
        <div className="cc-wizard-progress-bar" style={{ width: `${progress}%` }} />
      </div>

      <nav className="cc-wizard-steps" aria-label="Setup progress">
        {stepList.map((id, i) => (
          <button
            key={id}
            type="button"
            className={`cc-wizard-step${i <= currentIdx ? ' done' : ''}${i === currentIdx ? ' active' : ''}${i < currentIdx ? ' clickable' : ''}`}
            disabled={i > currentIdx || step === 'connect'}
            onClick={() => i < currentIdx && goTo(id)}
          >
            <span className="cc-wizard-step-num">{i < currentIdx ? '✓' : i + 1}</span>
            <span className="cc-wizard-step-label">{STEP_LABELS[id]}</span>
          </button>
        ))}
      </nav>

      <div className="cc-wizard-layout">
        <main className="cc-wizard-main">
          {error && step !== 'connect' && (
            <div className="cc-wizard-alert" role="alert">
              <AlertCircle size={18} />
              {error}
            </div>
          )}

          {step === 'start' && (
            <section className="cc-wizard-panel">
              <h3>What&apos;s your situation?</h3>
              <p className="cc-wizard-lead">We&apos;ll only show the steps you need — no jargon, no duplicate buttons.</p>
              <div className="cc-wizard-scenario-grid">
                {SCENARIOS.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className={`cc-wizard-scenario${scenario === s.id ? ' selected' : ''}`}
                    onClick={() => setScenario(s.id)}
                  >
                    {s.badge && <span className="cc-wizard-scenario-badge">{s.badge}</span>}
                    <div className="cc-wizard-scenario-icon">{s.icon}</div>
                    <strong>{s.title}</strong>
                    <p>{s.desc}</p>
                  </button>
                ))}
              </div>
              {remoteServer && scenario !== 'onsite' && (
                <div className="cc-wizard-tip">
                  <Smartphone size={16} />
                  <span>
                    CarTrack runs on a <strong>cloud server</strong>. Wi‑Fi setup must be done from a phone/PC on the camera hotspot.
                  </span>
                </div>
              )}
            </section>
          )}

          {step === 'identify' && (
            <section className="cc-wizard-panel">
              <h3>Identify your camera</h3>
              <p className="cc-wizard-lead">Scan the label QR or type the serial. Password is the one you set in DMSS — not the QR security code.</p>
              <div className="cc-wizard-field-grid">
                <label className="cc-wizard-field span-2">
                  <span>Serial number (SN)</span>
                  <input value={serial} onChange={e => setSerial(e.target.value.toUpperCase())} placeholder="BF0E4C7GAGB833C" spellCheck={false} />
                </label>
                <label className="cc-wizard-field span-2">
                  <span>Device password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={passwordSaved ? 'Saved — type only to change' : 'From DMSS device settings'}
                    autoComplete="new-password"
                  />
                  {passwordSaved && !password && <em className="cc-wizard-hint ok">Password saved on server</em>}
                </label>
                {(scenario === 'onsite' || method === 'lan') && (
                  <label className="cc-wizard-field span-2">
                    <span>Camera LAN IP</span>
                    <input value={lanHost} onChange={e => setLanHost(e.target.value)} placeholder="192.168.1.138 from DMSS" spellCheck={false} />
                  </label>
                )}
              </div>
              <div className="cc-wizard-qr-row">
                <input value={qrText} onChange={e => setQrText(e.target.value)} placeholder="{SN:...,DT:...,SC:...}" spellCheck={false} />
                <button type="button" className="btn btn-primary" onClick={() => setQrOpen(true)}>
                  <QrCode size={16} /> Scan QR
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void applyQr()}>
                  Apply
                </button>
              </div>
            </section>
          )}

          {step === 'wifi' && (
            <section className="cc-wizard-panel">
              <h3>{scenario === 'relocate' ? 'Connect camera to the new Wi‑Fi' : 'Connect camera to shop Wi‑Fi'}</h3>
              <p className="cc-wizard-lead">
                {scenario === 'relocate' && cloudOnline === true ? (
                  <>
                    Your camera is still <strong>online on the old network</strong>. You can also use{' '}
                    <strong>Settings → Cameras → Wi‑Fi → Remote switch</strong> without visiting the site.
                    Use the steps below if it is already offline or at the new location.
                  </>
                ) : (
                  <>On this device: join hotspot <strong>Dahua_XXXX</strong> → find camera → scan Wi‑Fi → send password.</>
                )}
              </p>
              <div className="cc-wizard-field-grid">
                <label className="cc-wizard-field">
                  <span>Camera IP (hotspot)</span>
                  <input value={camHost} onChange={e => setCamHost(e.target.value)} disabled={!!wifiBusy} />
                </label>
                <label className="cc-wizard-field">
                  <span>Shop Wi‑Fi (SSID)</span>
                  <input value={wifiSsid} onChange={e => setWifiSsid(e.target.value)} placeholder="Your 2.4 GHz network" disabled={!!wifiBusy} />
                </label>
                {wifiNets.length > 0 && (
                  <div className="cc-wizard-chip-row span-2">
                    {wifiNets.map(n => (
                      <button key={`${n.ssid}-${n.bssid}`} type="button" className="cc-wizard-chip" onClick={() => setWifiSsid(n.ssid)}>
                        {n.ssid}
                      </button>
                    ))}
                  </div>
                )}
                <label className="cc-wizard-field span-2">
                  <span>Shop Wi‑Fi password</span>
                  <input type="password" value={wifiPassword} onChange={e => setWifiPassword(e.target.value)} disabled={!!wifiBusy} />
                </label>
              </div>
              <div className="cc-wizard-action-row">
                <button type="button" className="btn btn-secondary" disabled={!!wifiBusy} onClick={() => void discoverCam()}>
                  {wifiBusy === 'discover' ? <Loader2 size={14} className="spin" /> : <Radio size={14} />}
                  1. Find camera
                </button>
                <button type="button" className="btn btn-secondary" disabled={!!wifiBusy} onClick={() => void scanWifi()}>
                  {wifiBusy === 'scan' ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}
                  2. Scan Wi‑Fi
                </button>
                <button type="button" className="btn btn-primary" disabled={!!wifiBusy} onClick={() => void sendWifi()}>
                  {wifiBusy === 'connect' ? <Loader2 size={14} className="spin" /> : null}
                  3. Send to camera
                </button>
              </div>
            </section>
          )}

          {step === 'method' && (
            <section className="cc-wizard-panel">
              <h3>How should CarTrack connect?</h3>
              <p className="cc-wizard-lead">
                <strong>CarTrack Cloud</strong> uses the same DMSS-style relay as the phone app — zero Imou developer API calls.
              </p>
              <div className="cc-wizard-method-grid">
                {primaryMethods.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    className={`cc-wizard-method${method === m.id ? ' selected' : ''}`}
                    onClick={() => pickMethod(m.id)}
                  >
                    {m.badge && <span className="cc-wizard-method-badge">{m.badge}</span>}
                    <div className="cc-wizard-method-icon">{m.icon}</div>
                    <strong>{m.title}</strong>
                    <p>{m.desc}</p>
                    <ul>
                      {m.pros.map(p => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>

              {advancedMethods.length > 0 && (
                <div className="cc-wizard-advanced">
                  <button type="button" className="cc-wizard-advanced-toggle" onClick={toggleAdvancedMethods}>
                    {showAdvancedMethods ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    Advanced — Imou developer API
                    <span className="cc-wizard-advanced-hint">metered quota, not for daily video</span>
                  </button>
                  {showAdvancedMethods && (
                    <>
                      <div className="cc-wizard-tip" style={{ marginTop: 12, marginBottom: 12 }}>
                        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>
                          This path counts against your Imou developer app (~30,000 calls/month). DMSS never uses this API.
                          For live video, stay on <strong>CarTrack Cloud</strong>. Use Advanced only if you need in-app remote Wi‑Fi switch via Imou.
                        </span>
                      </div>
                      <div className="cc-wizard-method-grid cc-wizard-method-grid--advanced">
                        {advancedMethods.map(m => (
                          <button
                            key={m.id}
                            type="button"
                            className={`cc-wizard-method cc-wizard-method--advanced${method === m.id ? ' selected' : ''}`}
                            onClick={() => pickMethod(m.id)}
                          >
                            <div className="cc-wizard-method-icon">{m.icon}</div>
                            <strong>{m.title}</strong>
                            <p>{m.desc}</p>
                            <ul>
                              {m.pros.map(p => (
                                <li key={p}>{p}</li>
                              ))}
                            </ul>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="cc-wizard-dest">
                <span className="cc-wizard-dest-label">After connect, open</span>
                <label className={destination === 'multicam' ? 'selected' : ''}>
                  <input type="radio" checked={destination === 'multicam'} onChange={() => setDestination('multicam')} />
                  <Grid2X2 size={16} /> Camera wall
                </label>
                <label className={destination === 'anpr' ? 'selected' : ''}>
                  <input type="radio" checked={destination === 'anpr'} onChange={() => setDestination('anpr')} />
                  <Gauge size={16} /> ANPR live
                </label>
              </div>
            </section>
          )}

          {step === 'connect' && (
            <section className="cc-wizard-panel cc-wizard-connect">
              <h3>{connectPhase === 'failed' ? 'Connection failed' : connectPhase === 'done' ? 'Connected!' : 'Connecting…'}</h3>
              <p className="cc-wizard-lead">
                {connectPhase === 'failed'
                  ? 'Fix the issue below, then try again. Close DMSS/Imou Life on phones first.'
                  : 'This can take up to 90 seconds. Keep this tab open.'}
              </p>
              <ul className="cc-wizard-checklist">
                {[
                  { id: 'save', label: 'Save camera credentials', phases: ['save'], doneAfter: ['tunnel', 'test', 'live', 'done'] },
                  { id: 'tunnel', label: method === 'lan' ? 'Reach camera on LAN' : method === 'cloud_hls' ? 'Link Imou & open stream' : 'Open CarTrack Cloud tunnel', phases: ['tunnel'], doneAfter: ['test', 'live', 'done'] },
                  { id: 'test', label: 'Verify video stream', phases: ['test'], doneAfter: ['live', 'done'] },
                  { id: 'live', label: 'Start live feed', phases: ['live'], doneAfter: ['done'] },
                ].map(item => {
                  const done = item.doneAfter.includes(connectPhase);
                  const active = item.phases.includes(connectPhase);
                  return (
                    <li key={item.id} className={`${done ? 'done' : ''}${active ? ' active' : ''}`}>
                      {done ? <CheckCircle2 size={18} /> : active ? <Loader2 size={18} className="spin" /> : <span className="cc-wizard-check-empty" />}
                      {item.label}
                    </li>
                  );
                })}
              </ul>
              {statusLine && (
                <div className={`cc-wizard-status${connectPhase === 'failed' ? ' err' : connectPhase === 'done' ? ' ok' : ''}`}>
                  {connectPhase === 'failed' ? <AlertCircle size={16} /> : connectPhase === 'done' ? <CheckCircle2 size={16} /> : <Loader2 size={16} className="spin" />}
                  {statusLine}
                </div>
              )}
              {connectPhase === 'failed' && (
                <button type="button" className="btn btn-primary" onClick={() => { connectStarted.current = false; setConnectPhase('idle'); setError(null); void runConnect(); }}>
                  Try again
                </button>
              )}
            </section>
          )}

          {step === 'success' && (
            <section className="cc-wizard-panel cc-wizard-success">
              <div className="cc-wizard-success-icon">
                <CheckCircle2 size={48} />
              </div>
              <h3>Camera is live</h3>
              <p className="cc-wizard-lead">
                Connected via <strong>{connectionVia === 'lan' ? 'shop LAN' : method === 'cloud_hls' ? 'Imou cloud' : 'CarTrack Cloud'}</strong>.
                Serial <code>{serial}</code>
              </p>
              <div className="cc-wizard-success-actions">
                <button type="button" className="btn btn-primary btn-lg" onClick={openLive}>
                  Open live feed <ArrowRight size={18} />
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => goTo('start')}>
                  <Home size={16} /> Run setup again
                </button>
              </div>
            </section>
          )}
        </main>

        <aside className="cc-wizard-aside">
          <h4>Quick help</h4>
          {step === 'start' && (
            <ul>
              <li><strong>New camera?</strong> Choose first option — we’ll do Wi‑Fi before cloud.</li>
              <li><strong>Already in DMSS?</strong> Choose “Already on Wi‑Fi” — skip Wi‑Fi step.</li>
            </ul>
          )}
          {step === 'identify' && (
            <ul>
              <li>Serial is on the camera label (SN:…).</li>
              <li>Password = device admin password from DMSS, <em>not</em> the QR security code (SC).</li>
            </ul>
          )}
          {step === 'wifi' && (
            <ul>
              <li>Join <strong>Dahua_XXXX</strong> hotspot on this phone/PC first.</li>
              <li>Default camera IP: <strong>192.168.1.108</strong></li>
              <li>Wait 1–2 min after sending Wi‑Fi before connecting.</li>
            </ul>
          )}
          {step === 'method' && (
            <ul>
              <li><strong>CarTrack Cloud</strong> — DMSS-style relay, no Imou API, no OP1013.</li>
              <li><strong>Shop LAN</strong> — when you are on-site at the shop.</li>
              <li><strong>Advanced / Imou</strong> — remote Wi‑Fi only; uses monthly quota.</li>
              <li>Close DMSS live view on phones — one stream at a time.</li>
            </ul>
          )}
          {step === 'connect' && (
            <ul>
              <li>First connect may take 60–90 seconds.</li>
              <li>If it fails: power-cycle camera, wait 2 min, retry.</li>
            </ul>
          )}
          {step === 'success' && (
            <ul>
              <li>Manage all cameras under Settings → Cameras.</li>
              <li>Change Wi‑Fi later from the camera wall menu.</li>
            </ul>
          )}
        </aside>
      </div>

      {step !== 'connect' && step !== 'success' && (
        <footer className="cc-wizard-footer">
          {currentIdx > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={goBack}>
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <span />
          )}
          {step === 'wifi' ? (
            <button type="button" className="btn btn-secondary" onClick={goNext}>
              Skip — already on Wi‑Fi <ArrowRight size={16} />
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={goNext}>
              Continue <ArrowRight size={16} />
            </button>
          )}
        </footer>
      )}

      <DahuaQrScanner open={qrOpen} onClose={() => setQrOpen(false)} onScan={raw => void applyQr(raw)} title="Scan camera label" />
    </div>
  );
};
