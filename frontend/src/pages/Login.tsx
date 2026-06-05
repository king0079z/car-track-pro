import React, { useState, FormEvent, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { settingsApi } from '../services/api';
import { syncClientTimeFromPublicSettings } from '../lib/qatarTime';
import toast from 'react-hot-toast';

// ── Animated particle orb ─────────────────────────────────────────────
const Orb: React.FC<{ style: React.CSSProperties }> = ({ style }) => (
  <div style={style} className="orb" />
);

// ── Animated counter ──────────────────────────────────────────────────
const AnimatedCounter: React.FC<{ target: number; suffix?: string; duration?: number }> = ({
  target, suffix = '', duration = 2000,
}) => {
  const [count, setCount] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const steps = 60;
    const stepMs = duration / steps;
    let current = 0;
    ref.current = setInterval(() => {
      current += target / steps;
      if (current >= target) {
        setCount(target);
        if (ref.current) clearInterval(ref.current);
      } else {
        setCount(Math.floor(current));
      }
    }, stepMs);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [target, duration]);

  return <span>{count.toLocaleString()}{suffix}</span>;
};

// ── Car SVG icon (sleek) ──────────────────────────────────────────────
const CarIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 64 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 22h48M12 22l6-12h28l6 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18 10l3-6h22l3 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    <circle cx="18" cy="24" r="4" stroke="currentColor" strokeWidth="2.5"/>
    <circle cx="46" cy="24" r="4" stroke="currentColor" strokeWidth="2.5"/>
    <path d="M4 22h4M56 22h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    <path d="M22 10h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
  </svg>
);

// ── Live stats bar ─────────────────────────────────────────────────────
const stats = [
  { label: 'Cars Tracked Daily', value: 2400, suffix: '+' },
  { label: 'AI Detections', value: 99, suffix: '%' },
  { label: 'Service Centers', value: 50, suffix: '+' },
  { label: 'Uptime', value: 99.9, suffix: '%' },
];

export const Login: React.FC = () => {
  const { login, isAuthenticated } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [inputFocused, setInputFocused] = useState<'user' | 'pass' | null>(null);
  const [publicSettings, setPublicSettings] = useState<{
    business_name?: string;
    maintenance_message?: string;
  }>({});

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    settingsApi
      .public()
      .then(res => {
        setPublicSettings(res.data);
        syncClientTimeFromPublicSettings(res.data);
      })
      .catch(() => {});
  }, []);

  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) { toast.error('Please fill in all fields'); return; }
    setLoading(true);
    try {
      await login(username, password);
      toast.success('Welcome back!');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes orbFloat1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(60px, -80px) scale(1.15); }
          66% { transform: translate(-40px, 40px) scale(0.9); }
        }
        @keyframes orbFloat2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(-70px, 60px) scale(1.1); }
          66% { transform: translate(50px, -50px) scale(0.95); }
        }
        @keyframes orbFloat3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(40px, 70px) scale(1.2); }
        }
        @keyframes gridPulse {
          0%, 100% { opacity: 0.03; }
          50% { opacity: 0.07; }
        }
        @keyframes scanLine {
          0% { transform: translateY(-100%); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(100vh); opacity: 0; }
        }
        @keyframes carDrive {
          0% { transform: translateX(-120px); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateX(calc(100vw + 120px)); opacity: 0; }
        }
        @keyframes cardEnter {
          0% { opacity: 0; transform: translateY(32px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes logoEnter {
          0% { opacity: 0; transform: translateY(-20px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes statFadeIn {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 4px 24px rgba(37, 99, 235, 0.08), 0 0 0 1px rgba(226, 232, 240, 0.9); }
          50% { box-shadow: 0 8px 32px rgba(37, 99, 235, 0.14), 0 0 0 1px rgba(191, 219, 254, 0.9); }
        }
        @keyframes borderGlow {
          0%, 100% { border-color: rgba(59,130,246,0.3); }
          50% { border-color: rgba(59,130,246,0.8); }
        }
        @keyframes dotPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.7; }
        }
        @keyframes typeWriter {
          0% { width: 0; }
          100% { width: 100%; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .orb {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          pointer-events: none;
        }
        .scan-line {
          position: absolute;
          left: 0; right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(59,130,246,0.6), transparent);
          animation: scanLine 8s ease-in-out infinite;
          animation-delay: 2s;
        }
        .car-drive {
          position: absolute;
          bottom: 80px;
          animation: carDrive 12s linear infinite;
        }
        .shimmer-text {
          background: linear-gradient(90deg,
            #1d4ed8 0%, #2563eb 20%, #0f172a 40%, #1d4ed8 60%, #2563eb 80%, #0f172a 100%
          );
          background-size: 200% auto;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: shimmer 4s linear infinite;
        }
        .card-glow {
          animation: pulseGlow 4s ease-in-out infinite;
        }
        .input-focus-ring {
          transition: box-shadow 0.3s, border-color 0.3s;
        }
        .input-focus-ring:focus {
          box-shadow: 0 0 0 2px rgba(59,130,246,0.5), 0 0 20px rgba(59,130,246,0.15);
          border-color: rgba(59,130,246,0.8);
        }
        .btn-submit {
          position: relative;
          overflow: hidden;
          transition: all 0.3s;
        }
        .btn-submit::before {
          content: '';
          position: absolute;
          top: 0; left: -100%;
          width: 100%; height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
          transition: left 0.5s;
        }
        .btn-submit:hover::before {
          left: 100%;
        }
        .btn-submit:hover {
          transform: translateY(-1px);
          box-shadow: 0 8px 25px rgba(37,99,235,0.5);
        }
        .btn-submit:active {
          transform: translateY(0);
        }
        .stat-item {
          animation: statFadeIn 0.6s ease forwards;
          opacity: 0;
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(160deg, #f8fafc 0%, #eef2ff 45%, #f1f5f9 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        fontFamily: "'Inter', sans-serif",
      }}>

        {/* Grid overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `
            linear-gradient(rgba(59,130,246,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(59,130,246,0.05) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          animation: 'gridPulse 6s ease-in-out infinite',
        }} />

        {/* Scan line effect */}
        <div className="scan-line" />

        {/* Animated orbs */}
        <div className="orb" style={{
          width: 600, height: 600,
          background: 'radial-gradient(circle, rgba(37,99,235,0.12) 0%, transparent 70%)',
          top: '-200px', left: '-200px',
          animation: 'orbFloat1 15s ease-in-out infinite',
        }} />
        <div className="orb" style={{
          width: 500, height: 500,
          background: 'radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%)',
          bottom: '-150px', right: '-150px',
          animation: 'orbFloat2 18s ease-in-out infinite',
        }} />
        <div className="orb" style={{
          width: 300, height: 300,
          background: 'radial-gradient(circle, rgba(6,182,212,0.15) 0%, transparent 70%)',
          top: '40%', right: '20%',
          animation: 'orbFloat3 12s ease-in-out infinite',
        }} />

        {/* Driving car silhouette */}
        <div className="car-drive" style={{ animationDelay: '4s' }}>
          <div style={{ width: 80, color: 'rgba(59,130,246,0.15)', filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.3))' }}>
            <CarIcon />
          </div>
        </div>
        <div className="car-drive" style={{ bottom: 120, animationDelay: '10s', animationDuration: '16s' }}>
          <div style={{ width: 50, color: 'rgba(139,92,246,0.12)', filter: 'drop-shadow(0 0 6px rgba(139,92,246,0.3))' }}>
            <CarIcon />
          </div>
        </div>

        {/* Corner decorations */}
        <div style={{
          position: 'absolute', top: 24, left: 24,
          display: 'flex', alignItems: 'center', gap: 8, opacity: 0.4,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', animation: 'dotPulse 2s ease-in-out infinite' }} />
          <div style={{ width: 60, height: 1, background: 'linear-gradient(90deg, #3b82f6, transparent)' }} />
        </div>
        <div style={{
          position: 'absolute', top: 24, right: 24,
          display: 'flex', alignItems: 'center', gap: 8, opacity: 0.4, flexDirection: 'row-reverse',
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#8b5cf6', animation: 'dotPulse 2s ease-in-out infinite', animationDelay: '1s' }} />
          <div style={{ width: 60, height: 1, background: 'linear-gradient(270deg, #8b5cf6, transparent)' }} />
        </div>

        {/* Main content */}
        <div style={{
          position: 'relative', zIndex: 10,
          width: '100%', maxWidth: 480,
          padding: '0 24px',
          opacity: mounted ? 1 : 0,
          transition: 'opacity 0.5s ease',
        }}>

          {publicSettings.maintenance_message ? (
            <div
              role="status"
              style={{
                marginBottom: 22,
                padding: '12px 16px',
                borderRadius: 14,
                border: '1px solid rgba(251,191,36,0.45)',
                background: 'linear-gradient(135deg, rgba(251,191,36,0.12), rgba(245,158,11,0.06))',
                color: 'var(--text-warning)',
                fontSize: 13,
                lineHeight: 1.5,
                textAlign: 'center',
              }}
            >
              {publicSettings.maintenance_message}
            </div>
          ) : null}

          {/* Logo + Brand */}
          <div style={{
            textAlign: 'center', marginBottom: 40,
            animation: mounted ? 'logoEnter 0.8s ease forwards' : 'none',
          }}>
            {/* Logo ring */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 88, height: 88, borderRadius: 24, marginBottom: 20,
              background: 'linear-gradient(135deg, #1e40af, #7c3aed)',
              boxShadow: '0 0 0 1px rgba(59,130,246,0.3), 0 20px 60px rgba(37,99,235,0.4)',
              animation: 'pulseGlow 3s ease-in-out infinite',
              position: 'relative',
            }}>
              {/* Spinning ring */}
              <div style={{
                position: 'absolute', inset: -3,
                borderRadius: 27, border: '2px solid transparent',
                borderTopColor: 'var(--text-accent)',
                borderRightColor: 'transparent',
                animation: 'spin 3s linear infinite',
              }} />
              <div style={{ width: 48, color: 'white' }}><CarIcon /></div>
            </div>

            <h1 style={{
              fontSize: 32, fontWeight: 800, margin: '0 0 6px',
              letterSpacing: '-0.5px',
            }}>
              <span className="shimmer-text">{publicSettings.business_name?.trim() || 'CarTrack Pro'}</span>
            </h1>
            <p style={{
              color: '#4b5563', fontSize: 13, margin: 0,
              letterSpacing: '3px', textTransform: 'uppercase', fontWeight: 600,
            }}>
              AI • Monitoring • Analytics
            </p>
          </div>

          {/* Login card */}
          <div style={{
            background: '#ffffff',
            backdropFilter: 'blur(24px)',
            border: '1px solid #e2e8f0',
            borderRadius: 24,
            padding: '36px 40px',
            boxShadow: '0 4px 24px rgba(15, 23, 42, 0.06), 0 0 0 1px rgba(226, 232, 240, 0.8)',
            animation: mounted ? 'cardEnter 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both' : 'none',
          }} className="card-glow">

            <div style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>
                Welcome back
              </h2>
              <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
                Sign in to your control center
              </p>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Username */}
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: inputFocused === 'user' ? 'var(--text-accent)' : '#9ca3af',
                  marginBottom: 6, textTransform: 'uppercase', letterSpacing: '1px',
                  transition: 'color 0.2s',
                }}>Username</label>
                <div style={{ position: 'relative' }}>
                  <div style={{
                    position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
                    color: inputFocused === 'user' ? 'var(--text-accent)' : '#4b5563',
                    transition: 'color 0.2s', pointerEvents: 'none', fontSize: 15,
                  }}>@</div>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    onFocus={() => setInputFocused('user')}
                    onBlur={() => setInputFocused(null)}
                    autoFocus
                    style={{
                      width: '100%', padding: '14px 16px 14px 36px',
                      background: '#f8fafc',
                      border: `1px solid ${inputFocused === 'user' ? 'rgba(59,130,246,0.55)' : '#e2e8f0'}`,
                      borderRadius: 14, color: '#0f172a', fontSize: 15,
                      outline: 'none', boxSizing: 'border-box',
                      boxShadow: inputFocused === 'user' ? '0 0 0 3px rgba(59,130,246,0.15), 0 0 20px rgba(59,130,246,0.1)' : 'none',
                      transition: 'all 0.25s',
                    }}
                    placeholder="Enter username"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: inputFocused === 'pass' ? 'var(--text-accent)' : '#9ca3af',
                  marginBottom: 6, textTransform: 'uppercase', letterSpacing: '1px',
                  transition: 'color 0.2s',
                }}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onFocus={() => setInputFocused('pass')}
                    onBlur={() => setInputFocused(null)}
                    style={{
                      width: '100%', padding: '14px 48px 14px 16px',
                      background: '#f8fafc',
                      border: `1px solid ${inputFocused === 'pass' ? 'rgba(59,130,246,0.55)' : '#e2e8f0'}`,
                      borderRadius: 14, color: '#0f172a', fontSize: 15,
                      outline: 'none', boxSizing: 'border-box',
                      boxShadow: inputFocused === 'pass' ? '0 0 0 3px rgba(59,130,246,0.15), 0 0 20px rgba(59,130,246,0.1)' : 'none',
                      transition: 'all 0.25s',
                    }}
                    placeholder="Enter password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: '#6b7280', padding: 4, display: 'flex', alignItems: 'center',
                      transition: 'color 0.2s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-accent)')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="btn-submit"
                style={{
                  width: '100%', padding: '15px',
                  background: loading
                    ? 'rgba(37,99,235,0.6)'
                    : 'linear-gradient(135deg, #1d4ed8, #2563eb, #7c3aed)',
                  border: 'none', borderRadius: 14, cursor: loading ? 'not-allowed' : 'pointer',
                  color: 'white', fontSize: 15, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  boxShadow: '0 4px 24px rgba(37,99,235,0.35)',
                  marginTop: 4,
                  letterSpacing: '0.3px',
                }}
              >
                {loading ? (
                  <>
                    <div style={{
                      width: 18, height: 18,
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: 'white',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }} />
                    Authenticating...
                  </>
                ) : (
                  <>
                    <span>Access Dashboard</span>
                    <span style={{ fontSize: 18 }}>→</span>
                  </>
                )}
              </button>
            </form>

            {/* Divider */}
            <div style={{
              margin: '28px 0 0',
              padding: '20px 0 0',
              borderTop: '1px solid rgba(55,65,81,0.5)',
              textAlign: 'center',
            }}>
              <p style={{ margin: 0, fontSize: 12, color: '#374151' }}>
                Default:{' '}
                <code style={{
                  background: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.15)',
                  borderRadius: 6, padding: '2px 8px',
                  color: 'var(--text-accent)', fontFamily: 'monospace', fontSize: 12,
                }}>
                  admin / demo1234
                </code>
              </p>
            </div>
          </div>

          {/* Live stats */}
          <div style={{
            marginTop: 32,
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            animation: mounted ? 'statFadeIn 0.8s ease 0.6s both' : 'none',
          }}>
            {stats.map((s, i) => (
              <div key={s.label} className="stat-item" style={{
                animationDelay: `${0.6 + i * 0.1}s`,
                background: 'rgba(17,24,39,0.6)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(59,130,246,0.08)',
                borderRadius: 12,
                padding: '12px 8px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-accent)', lineHeight: 1 }}>
                  {mounted && <AnimatedCounter target={s.value} suffix={s.suffix} duration={1500 + i * 300} />}
                </div>
                <div style={{ fontSize: 10, color: '#4b5563', marginTop: 4, fontWeight: 500, lineHeight: 1.3 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <p style={{
            textAlign: 'center', color: '#1f2937', fontSize: 11,
            marginTop: 24, letterSpacing: '0.5px',
          }}>
            © 2026 CarTrack Pro — Enterprise AI Monitoring Platform
          </p>
        </div>
      </div>

      {/* Global spin keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
};
