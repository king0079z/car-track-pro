import React, { useState } from 'react';
import { Cloud, Smartphone, Wifi, X } from 'lucide-react';
import { CameraFirstTimeSetup } from './CameraFirstTimeSetup';
import { CameraWifiDialog } from './CameraWifiDialog';

type Mode = 'remote' | 'onsite';

/**
 * Unified Wi-Fi change — same two paths as DMSS:
 *  • Remote: camera still online on old Wi-Fi (Imou cloud API)
 *  • On-site: camera hotspot / Soft AP (browser → camera HTTP, like DMSS location+WiFi step)
 */
export const CameraChangeWifiDialog: React.FC<{
  cameraId: string;
  cameraName: string;
  deviceSerial?: string;
  remoteServer?: boolean;
  isOpen: boolean;
  onClose: () => void;
}> = ({ cameraId, cameraName, deviceSerial = '', remoteServer = true, isOpen, onClose }) => {
  const [mode, setMode] = useState<Mode>('remote');
  const [serial, setSerial] = useState(deviceSerial);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: mode === 'onsite' ? 520 : 480, maxHeight: '92vh', overflowY: 'auto',
          borderRadius: 16, border: '1px solid var(--border-light)', background: 'var(--bg-elevated)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid var(--border-light)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 800 }}>
            <Wifi size={18} color="#3b82f6" /> Change Wi-Fi — {cameraName}
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '12px 18px 0', display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => setMode('remote')}
            style={{
              flex: 1, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              border: `1px solid ${mode === 'remote' ? 'rgba(59,130,246,0.5)' : 'var(--border-light)'}`,
              background: mode === 'remote' ? 'rgba(59,130,246,0.12)' : 'var(--bg-surface)',
              color: 'var(--text-primary)', textAlign: 'left',
            }}
          >
            <Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            Remote switch
            <div style={{ fontWeight: 500, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Camera still online on old Wi-Fi
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode('onsite')}
            style={{
              flex: 1, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              border: `1px solid ${mode === 'onsite' ? 'rgba(59,130,246,0.5)' : 'var(--border-light)'}`,
              background: mode === 'onsite' ? 'rgba(59,130,246,0.12)' : 'var(--bg-surface)',
              color: 'var(--text-primary)', textAlign: 'left',
            }}
          >
            <Smartphone size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            On-site (Soft AP)
            <div style={{ fontWeight: 500, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              At the camera — DMSS-style hotspot
            </div>
          </button>
        </div>

        {mode === 'remote' ? (
          <CameraWifiDialog
            embedded
            cameraId={cameraId}
            cameraName={cameraName}
            isOpen
            onClose={onClose}
          />
        ) : (
          <div style={{ padding: '12px 18px 18px' }}>
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 14,
              background: 'rgba(59,130,246,0.08)', borderRadius: 10, padding: '10px 12px',
            }}>
              <strong>Same as DMSS “Add device → Soft AP”:</strong> put the camera in pairing mode (hold reset ~5s until
              it blinks), on your phone turn off mobile data, join Wi‑Fi <strong>Dahua_XXXX</strong>, then run the steps
              below. DMSS also asks for Location/Bluetooth — that is for the native app; CarTrack talks to the camera
              directly over HTTP at <strong>192.168.1.108</strong> while you are on its hotspot.
            </div>
            <CameraFirstTimeSetup
              serial={serial || deviceSerial}
              securityCode=""
              remoteServer={remoteServer}
              onSerial={setSerial}
              onPasswordSaved={onClose}
            />
          </div>
        )}
      </div>
    </div>
  );
};
