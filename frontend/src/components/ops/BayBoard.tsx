import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Visit } from '../../types';

interface Props {
  visits: Visit[];
  totalBays: number;
}

export const BayBoard: React.FC<Props> = ({ visits, totalBays }) => {
  const bayMap = useMemo(() => {
    const m = new Map<number, Visit>();
    for (const v of visits) {
      if (v.assigned_bay != null && !m.has(v.assigned_bay)) {
        m.set(v.assigned_bay, v);
      }
    }
    return m;
  }, [visits]);

  const cols = Math.min(totalBays, 4);

  return (
    <div className="ops-bay-board" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {Array.from({ length: totalBays }, (_, i) => i + 1).map(bay => {
        const visit = bayMap.get(bay);
        const occupied = Boolean(visit);
        return (
          <div key={bay} className={`ops-bay-tile${occupied ? ' occupied' : ''}`}>
            <div className="ops-bay-num">Bay {bay}</div>
            {occupied && visit ? (
              <Link to={`/visits/${visit.id}`} className="ops-bay-plate">
                {visit.vehicle?.plate_number || '—'}
              </Link>
            ) : (
              <span className="ops-bay-free">Free</span>
            )}
            {occupied && visit?.service_items?.[0]?.service?.name && (
              <span className="ops-bay-svc">{visit.service_items[0].service.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
};
