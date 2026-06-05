import sys
sys.path.insert(0, '.')
from app.database import SessionLocal
from app.models.visit import Visit, VisitStatus
from app.models.service import ServiceItem, Service
from app.models.vehicle import Vehicle
from app.models.user import User
from app.models.camera import Camera
from sqlalchemy import func

db = SessionLocal()
active_statuses = ["waiting", "in_service", "on_hold"]

print("=== CARTRACK SYSTEM STATUS ===")
print(f"Users:          {db.query(User).count()}")
print(f"Vehicles:       {db.query(Vehicle).count()}")
print(f"Services:       {db.query(Service).count()}")
print(f"Cameras:        {db.query(Camera).count()}")
print(f"Total Visits:   {db.query(Visit).count()}")
print(f"Active Visits:  {db.query(Visit).filter(Visit.status.in_(active_statuses)).count()}")
print(f"Completed:      {db.query(Visit).filter(Visit.status == VisitStatus.COMPLETED).count()}")
print(f"Service Items:  {db.query(ServiceItem).count()}")
print(f"With Staff:     {db.query(ServiceItem).filter(ServiceItem.assigned_staff_id != None).count()}")
print(f"With Timing:    {db.query(ServiceItem).filter(ServiceItem.actual_duration_minutes != None).count()}")

rev = db.query(func.sum(Visit.total_price)).filter(Visit.status == VisitStatus.COMPLETED).scalar() or 0
print(f"Total Revenue:  QAR {rev:,.0f}")
db.close()
print("=== ALL SYSTEMS OK ===")
