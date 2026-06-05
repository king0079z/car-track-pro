import sys
sys.path.insert(0, '.')
from app.database import SessionLocal
from app.models.visit import Visit, VisitStatus
from app.models.vehicle import Vehicle
from app.models.service import Service, ServiceItem
from app.models.camera import Camera
from app.models.user import User
from sqlalchemy import func
from datetime import date, datetime, timedelta

db = SessionLocal()
today = date.today()
start30 = datetime.combine(today - timedelta(days=29), datetime.min.time())

total_visits   = db.query(Visit).count()
active_visits  = db.query(Visit).filter(Visit.status.in_(['waiting','in_service','on_hold'])).count()
completed      = db.query(Visit).filter(Visit.status == VisitStatus.COMPLETED).count()
today_count    = db.query(Visit).filter(func.date(Visit.entry_time) == today).count()
today_rev      = db.query(func.sum(Visit.total_price)).filter(func.date(Visit.entry_time)==today).scalar() or 0
total_vehicles = db.query(Vehicle).count()
total_services = db.query(Service).count()
total_cameras  = db.query(Camera).count()
active_cameras = db.query(Camera).filter(Camera.status == 'active').count()
total_users    = db.query(User).count()
total_sitems   = db.query(ServiceItem).count()
staff_assigned = db.query(ServiceItem).filter(ServiceItem.assigned_staff_id != None).count()
period_visits  = db.query(Visit).filter(Visit.entry_time >= start30).count()
period_rev     = db.query(func.sum(Visit.total_price)).filter(Visit.entry_time >= start30, Visit.status == VisitStatus.COMPLETED).scalar() or 0

print("PAGE          | STATUS | DATA")
print("-" * 55)
print(f"Dashboard     | {'OK' if active_visits > 0 else 'EMPTY':6} | active={active_visits}, today={today_count}, rev=QAR{today_rev:.0f}")
print(f"Visits        | {'OK' if total_visits > 0 else 'EMPTY':6} | total={total_visits}, active={active_visits}, completed={completed}")
print(f"Vehicles      | {'OK' if total_vehicles > 0 else 'EMPTY':6} | total={total_vehicles}")
print(f"Services      | {'OK' if total_services > 0 else 'EMPTY':6} | total={total_services}")
print(f"Analytics     | {'OK' if period_visits > 0 else 'EMPTY':6} | 30d_visits={period_visits}, 30d_rev=QAR{period_rev:.0f}")
print(f"Cameras       | {'OK' if total_cameras > 0 else 'EMPTY':6} | total={total_cameras}, active={active_cameras}")
print(f"Users         | {'OK' if total_users > 0 else 'EMPTY':6} | total={total_users}")
print(f"ServiceItems  | {'OK' if total_sitems > 0 else 'EMPTY':6} | total={total_sitems}, with_staff={staff_assigned}")
db.close()
