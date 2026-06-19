import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { Camera, Loader2, QrCode, SwitchCamera, X } from 'lucide-react';
import { parseDahuaQrPayload } from '../utils/dahuaQr';

type Props = {
  open: boolean;
  onClose: () => void;
  onScan: (rawText: string) => void;
  title?: string;
};

function pickPreferredCamera(devices: MediaDeviceInfo[], preferRear: boolean): string | undefined {
  if (!devices.length) return undefined;
  if (preferRear) {
    const rear = devices.find(d => /back|rear|environment/i.test(d.label));
    if (rear) return rear.deviceId;
  }
  const front = devices.find(d => /front|user|face/i.test(d.label));
  if (!preferRear && front) return front.deviceId;
  return devices[devices.length - 1]?.deviceId;
}

export const DahuaQrScanner: React.FC<Props> = ({
  open,
  onClose,
  onScan,
  title = 'Scan camera label QR',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [preferRear, setPreferRear] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    readerRef.current = null;
    setScanning(false);
  }, []);

  const handleClose = useCallback(() => {
    stopScanner();
    setCameraError(null);
    setPasteText('');
    onClose();
  }, [onClose, stopScanner]);

  const applyRaw = useCallback(
    (raw: string) => {
      try {
        parseDahuaQrPayload(raw);
        stopScanner();
        onScan(raw.trim());
        setPasteText('');
      } catch (err) {
        setCameraError(err instanceof Error ? err.message : 'Could not parse QR');
      }
    },
    [onScan, stopScanner],
  );

  const startScanner = useCallback(async () => {
    if (!videoRef.current) return;
    setCameraError(null);
    stopScanner();

    try {
      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 120,
        delayBetweenScanSuccess: 800,
      });
      readerRef.current = reader;

      let inputs = devices;
      if (!inputs.length) {
        inputs = await BrowserQRCodeReader.listVideoInputDevices();
        setDevices(inputs);
      }

      const selected = deviceId ?? pickPreferredCamera(inputs, preferRear);
      if (!selected && inputs.length) {
        setDeviceId(inputs[0].deviceId);
      }

      setScanning(true);
      const controls = await reader.decodeFromVideoDevice(
        selected,
        videoRef.current,
        (result, _err, ctrl) => {
          if (result) {
            ctrl.stop();
            applyRaw(result.getText());
          }
        },
      );
      controlsRef.current = controls;
    } catch (err) {
      setScanning(false);
      const msg = err instanceof Error ? err.message : String(err);
      if (/NotAllowed|Permission/i.test(msg)) {
        setCameraError('Camera access denied. Allow camera permission in your browser, or paste the QR text below.');
      } else if (/NotFound|DevicesNotFound/i.test(msg)) {
        setCameraError('No camera found on this device. Paste the QR text from the label instead.');
      } else {
        setCameraError(msg || 'Could not start camera');
      }
    }
  }, [applyRaw, deviceId, devices, preferRear, stopScanner]);

  useEffect(() => {
    if (!open) {
      stopScanner();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const inputs = await BrowserQRCodeReader.listVideoInputDevices();
        if (cancelled) return;
        setDevices(inputs);
        setDeviceId(pickPreferredCamera(inputs, true));
      } catch {
        if (!cancelled) setCameraError('Could not list cameras — paste QR text below.');
      }
    })();
    return () => {
      cancelled = true;
      stopScanner();
    };
  }, [open, stopScanner]);

  useEffect(() => {
    if (!open) return;
    void startScanner();
  }, [open, deviceId, preferRear]); // eslint-disable-line react-hooks/exhaustive-deps -- restart when camera changes

  const switchCamera = useCallback(() => {
    if (devices.length < 2) {
      setPreferRear(prev => !prev);
      return;
    }
    const idx = devices.findIndex(d => d.deviceId === deviceId);
    const next = devices[(idx + 1) % devices.length];
    setDeviceId(next.deviceId);
    setPreferRear(/back|rear|environment/i.test(next.label));
  }, [deviceId, devices]);

  if (!open) return null;

  return (
    <div className="dahua-qr-scanner-backdrop" onClick={handleClose} role="presentation">
      <div
        className="dahua-qr-scanner"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dahua-qr-scanner-title"
      >
        <header className="dahua-qr-scanner-header">
          <div>
            <h3 id="dahua-qr-scanner-title">{title}</h3>
            <p>Point your PC webcam or phone camera at the QR on the camera label.</p>
          </div>
          <button type="button" className="dahua-qr-scanner-close" onClick={handleClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>

        <div className="dahua-qr-scanner-viewport">
          <video ref={videoRef} className="dahua-qr-scanner-video" muted playsInline />
          {!scanning && !cameraError && (
            <div className="dahua-qr-scanner-placeholder">
              <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
              <span>Starting camera…</span>
            </div>
          )}
          <div className="dahua-qr-scanner-frame" aria-hidden="true" />
        </div>

        {cameraError && (
          <div className="dahua-qr-scanner-error" role="alert">{cameraError}</div>
        )}

        <div className="dahua-qr-scanner-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void startScanner()}>
            <Camera size={16} /> Retry camera
          </button>
          {devices.length > 1 && (
            <button type="button" className="btn btn-secondary" onClick={switchCamera}>
              <SwitchCamera size={16} /> Switch camera
            </button>
          )}
        </div>

        <div className="dahua-qr-scanner-paste">
          <span className="dahua-qr-scanner-paste-label">Or paste QR text</span>
          <div className="dahua-qr-scanner-paste-row">
            <input
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="{SN:...,DT:DH-H3A,SC:...}"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!pasteText.trim()}
              onClick={() => applyRaw(pasteText)}
            >
              <QrCode size={16} /> Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
