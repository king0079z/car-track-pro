export type ParsedDahuaQr = {
  serial: string;
  deviceType: string;
  securityCode: string;
  label: string;
};

/** Parse Dahua label QR text, e.g. {SN:BF0E4C7GAGB833C,DT:DH-H3A,SC:L219E7D3}. */
export function parseDahuaQrPayload(text: string): ParsedDahuaQr {
  const raw = (text || '').trim();
  const fields: Record<string, string> = {};

  if (raw.startsWith('{')) {
    const inner = raw.replace(/^\{|\}$/g, '').trim();
    for (const part of inner.split(',')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim().toUpperCase();
      const val = part.slice(colon + 1).trim();
      fields[key] = val;
    }
  } else {
    for (const part of raw.replace(/;/g, ',').split(',')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim().toUpperCase();
      const val = part.slice(colon + 1).trim();
      fields[key] = val;
    }
  }

  const serial = fields.SN ?? '';
  const deviceType = fields.DT ?? '';
  const securityCode = fields.SC ?? '';
  if (!serial && !deviceType) {
    throw new Error(
      'Unrecognized QR format. Expected Dahua label QR like {SN:...,DT:DH-H3A,SC:...}.',
    );
  }

  const label = deviceType || 'Dahua Hero A1';
  return { serial, deviceType, securityCode, label };
}
