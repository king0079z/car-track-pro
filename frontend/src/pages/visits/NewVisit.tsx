import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { WorkOrderWizard } from '../../components/WorkOrderWizard';

export const NewVisit: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const detectionRaw = searchParams.get('detection_id');
  const detectionId = detectionRaw ? parseInt(detectionRaw, 10) : undefined;

  return (
    <WorkOrderWizard
      mode="page"
      initial={{
        plate: searchParams.get('plate') || undefined,
        detection_id: Number.isFinite(detectionId) ? detectionId : undefined,
        owner_name: searchParams.get('owner_name') || undefined,
        owner_phone: searchParams.get('owner_phone') || undefined,
        bay: searchParams.get('bay') || undefined,
      }}
      onClose={() => navigate('/visits')}
    />
  );
};
