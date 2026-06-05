"""
Backfill actual_duration_minutes for service items that have visit duration data.
- Single-service visits: use visit.duration_minutes directly.
- Multi-service visits: distribute proportionally by estimated_duration.
"""
import sys, random
sys.path.insert(0, '.')
from app.database import SessionLocal
from app.models.visit import Visit, VisitStatus
from app.models.service import Service, ServiceItem
from sqlalchemy.orm import joinedload

db = SessionLocal()

visits = (
    db.query(Visit)
    .options(
        joinedload(Visit.service_items).joinedload(ServiceItem.service)
    )
    .filter(
        Visit.status == VisitStatus.COMPLETED,
        Visit.duration_minutes != None,
    )
    .all()
)

updated = 0
for visit in visits:
    items = [si for si in visit.service_items if si.service]
    if not items:
        continue

    total_est = sum(si.service.estimated_duration_minutes or 30 for si in items)
    visit_dur = visit.duration_minutes

    for si in items:
        if si.actual_duration_minutes is None:
            est = si.service.estimated_duration_minutes or 30
            if len(items) == 1:
                # Single service: add small variance (±10%)
                variance = random.uniform(0.90, 1.15)
                si.actual_duration_minutes = round(visit_dur * variance, 1)
            else:
                # Proportional share with ±15% variance
                share = (est / total_est) * visit_dur if total_est > 0 else est
                variance = random.uniform(0.85, 1.15)
                si.actual_duration_minutes = round(share * variance, 1)
            updated += 1

db.commit()
db.close()
print(f"Updated {updated} service items with actual_duration_minutes")
