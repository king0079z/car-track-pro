/** Canonical shop duration — matches backend visit_shop_duration_minutes. */
export function visitShopDurationMinutes(visit: {
  duration_minutes?: number | null;
  anpr_camera_seconds?: number | null;
  entry_time?: string;
  exit_time?: string | null;
  status?: string;
}): number | null {
  const cam =
    visit.anpr_camera_seconds != null && visit.anpr_camera_seconds > 0
      ? visit.anpr_camera_seconds / 60
      : null;
  if (cam != null) return cam;
  if (visit.duration_minutes != null && visit.duration_minutes > 0) {
    return visit.duration_minutes;
  }
  if (!visit.entry_time) return null;
  const start = new Date(visit.entry_time).getTime();
  if (Number.isNaN(start)) return null;
  const end = visit.exit_time ? new Date(visit.exit_time).getTime() : Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 60000);
}

export function isActiveVisitStatus(status?: string | null): boolean {
  return status === 'waiting' || status === 'in_service' || status === 'on_hold';
}
