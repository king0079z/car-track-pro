import React from 'react';
import type { VisitStatus, CameraStatus } from '../../types';

const visitStatusConfig: Record<VisitStatus, { label: string; className: string; dot: string }> = {
  waiting:    { label: 'Waiting',    className: 'badge-yellow', dot: 'bg-amber-400' },
  in_service: { label: 'In Service', className: 'badge-blue',   dot: 'bg-brand-400 animate-pulse' },
  on_hold:    { label: 'On Hold',    className: 'badge-gray',   dot: 'bg-gray-400' },
  completed:  { label: 'Completed',  className: 'badge-green',  dot: 'bg-emerald-400' },
  cancelled:  { label: 'Cancelled',  className: 'badge-red',    dot: 'bg-red-400' },
};

const cameraStatusConfig: Record<CameraStatus, { label: string; className: string; dot: string }> = {
  online:    { label: 'Online',    className: 'badge-green',  dot: 'bg-emerald-400 animate-pulse' },
  offline:   { label: 'Offline',   className: 'badge-gray',   dot: 'bg-gray-400' },
  recording: { label: 'Recording', className: 'badge-red',    dot: 'bg-red-400 animate-pulse' },
  error:     { label: 'Error',     className: 'badge-red',    dot: 'bg-red-400' },
};

export const VisitStatusBadge: React.FC<{ status: VisitStatus }> = ({ status }) => {
  const cfg = visitStatusConfig[status] || visitStatusConfig.waiting;
  return (
    <span className={cfg.className}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
};

export const CameraStatusBadge: React.FC<{ status: CameraStatus }> = ({ status }) => {
  const cfg = cameraStatusConfig[status] || cameraStatusConfig.offline;
  return (
    <span className={cfg.className}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
};
