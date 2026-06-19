import { useQuery } from '@tanstack/react-query';
import { analyticsApi, visitsApi } from '../services/api';

/** Live operational counts for nav badges and shift briefings. */
export function useOpsCounts() {
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => analyticsApi.dashboard().then(r => r.data),
    refetchInterval: 30000,
  });

  const { data: inShop = [] } = useQuery({
    queryKey: ['visits-in-shop'],
    queryFn: () => visitsApi.inShop().then(r => r.data),
    refetchInterval: 20000,
  });

  const inShopCount = stats?.cars_in_shop ?? inShop.filter((v: { source?: string }) => v.source === 'active_visit').length;
  const anprPending = stats?.anpr_pending_visits ?? inShop.filter((v: { source?: string }) => v.source === 'anpr_pending').length;
  const overdue = (stats as { overdue_visits?: number } | undefined)?.overdue_visits;

  return {
    inShopCount: inShopCount ?? 0,
    anprPending: anprPending ?? 0,
    overdue: overdue ?? 0,
    revenueToday: stats?.total_revenue_today ?? 0,
  };
}
