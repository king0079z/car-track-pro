"""
CarTrack AI — Comprehensive Demo Data Seeder
Run: py -3.13 seed.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from datetime import datetime, timedelta
import random

from app.database import SessionLocal, engine, Base
from app.models.user import User, UserRole
from app.models.vehicle import Vehicle
from app.models.service import Service, ServiceItem, ServiceCategory
from app.models.visit import Visit, VisitStatus, EntryMethod
from app.models.camera import Camera, CameraEvent
from app.models.audit import AuditLog
from app.utils.auth import hash_password
from app.utils.helpers import generate_visit_number

Base.metadata.create_all(bind=engine)
db = SessionLocal()

def wipe():
    # Delete in FK-safe order: child tables first, then parents
    for M in [CameraEvent, AuditLog, ServiceItem, Visit, Service, Vehicle, Camera, User]:
        db.query(M).delete()
    db.commit()
    print("[OK] Wiped existing data")

def seed_users():
    users_data = [
        dict(username="admin",   full_name="Ahmed Al-Rashidi",   email="admin@cartrack.qa",    role=UserRole.ADMIN,   phone="+974 5001 0001"),
        dict(username="manager", full_name="Sara Al-Mansoori",   email="manager@cartrack.qa",  role=UserRole.MANAGER, phone="+974 5001 0002"),
        dict(username="khalid",  full_name="Khalid Al-Hajri",    email="khalid@cartrack.qa",   role=UserRole.STAFF,   phone="+974 5001 0003"),
        dict(username="omar",    full_name="Omar Al-Farsi",      email="omar@cartrack.qa",     role=UserRole.STAFF,   phone="+974 5001 0004"),
        dict(username="yusuf",   full_name="Yusuf Al-Balushi",   email="yusuf@cartrack.qa",    role=UserRole.STAFF,   phone="+974 5001 0005"),
        dict(username="hassan",  full_name="Hassan Al-Kuwari",   email="hassan@cartrack.qa",   role=UserRole.STAFF,   phone="+974 5001 0006"),
        dict(username="viewer",  full_name="Noor Al-Naimi",      email="viewer@cartrack.qa",   role=UserRole.VIEWER,  phone="+974 5001 0007"),
    ]
    created = []
    for u in users_data:
        user = User(
            username=u["username"],
            full_name=u["full_name"],
            email=u["email"],
            hashed_password=hash_password("demo1234"),
            role=u["role"],
            phone=u["phone"],
            is_active=True,
        )
        db.add(user)
        created.append(user)
    db.commit()
    for u in created:
        db.refresh(u)
    print(f"[OK] Created {len(created)} users  (password: demo1234)")
    return {u.username: u for u in created}

def seed_cameras():
    cams = [
        dict(name="Entrance Gate",    location="entrance",    rtsp_url="rtsp://192.168.1.101:554/stream1", status="active", is_ai_enabled=True,  resolution="4MP"),
        dict(name="Exit Gate",         location="exit",        rtsp_url="rtsp://192.168.1.102:554/stream1", status="active", is_ai_enabled=True,  resolution="4MP"),
        dict(name="Bay 1 Overhead",    location="bay_1",       rtsp_url="rtsp://192.168.1.103:554/stream1", status="active", is_ai_enabled=False, resolution="2MP"),
        dict(name="Bay 2 Overhead",    location="bay_2",       rtsp_url="rtsp://192.168.1.104:554/stream1", status="active", is_ai_enabled=False, resolution="2MP"),
        dict(name="Bay 3 Overhead",    location="bay_3",       rtsp_url="rtsp://192.168.1.105:554/stream1", status="offline",is_ai_enabled=False, resolution="2MP"),
        dict(name="Waiting Area",      location="waiting",     rtsp_url="rtsp://192.168.1.106:554/stream1", status="active", is_ai_enabled=False, resolution="2MP"),
        dict(name="Office Reception",  location="reception",   rtsp_url="rtsp://192.168.1.107:554/stream1", status="active", is_ai_enabled=False, resolution="1MP"),
    ]
    for c in cams:
        db.add(Camera(
            name=c["name"], location=c["location"], rtsp_url=c["rtsp_url"],
            status=c["status"], resolution=c.get("resolution"),
            username="admin", password="cam1234", is_active=c["status"]=="active",
        ))
    db.commit()
    print(f"[OK] Created {len(cams)} cameras")

def seed_services():
    svcs = [
        # WASH
        dict(name="Express Wash",           category=ServiceCategory.WASH,        base_price=25,  est=20, desc="Quick exterior rinse and dry"),
        dict(name="Full Wash",              category=ServiceCategory.WASH,        base_price=45,  est=35, desc="Complete exterior wash with hand dry"),
        dict(name="Premium Wash & Wax",     category=ServiceCategory.WASH,        base_price=80,  est=50, desc="Full wash + hand wax for lasting shine"),
        dict(name="Interior Vacuum",        category=ServiceCategory.WASH,        base_price=30,  est=25, desc="Deep interior vacuuming and wipe-down"),
        dict(name="Full Detail Wash",       category=ServiceCategory.WASH,        base_price=120, est=90, desc="Complete interior + exterior detail wash"),
        # DETAILING
        dict(name="Interior Detailing",     category=ServiceCategory.DETAILING,   base_price=180, est=120, desc="Full interior deep clean, leather conditioning"),
        dict(name="Exterior Detailing",     category=ServiceCategory.DETAILING,   base_price=200, est=150, desc="Paint decontamination, clay bar, sealant"),
        dict(name="Full Car Detailing",     category=ServiceCategory.DETAILING,   base_price=350, est=240, desc="Complete inside and outside professional detailing"),
        dict(name="Engine Bay Clean",       category=ServiceCategory.DETAILING,   base_price=80,  est=60,  desc="Engine compartment degreasing and detailing"),
        # POLISH
        dict(name="Machine Polish",         category=ServiceCategory.POLISH,      base_price=250, est=180, desc="Single-stage machine polish to remove swirls"),
        dict(name="Paint Correction",       category=ServiceCategory.POLISH,      base_price=450, est=300, desc="Multi-stage paint correction, removes scratches"),
        dict(name="Headlight Restoration",  category=ServiceCategory.POLISH,      base_price=60,  est=45,  desc="UV-damaged headlight polishing and sealing"),
        dict(name="Ceramic Coating",        category=ServiceCategory.POLISH,      base_price=800, est=360, desc="Professional nano-ceramic coating (5yr protection)"),
        # MAINTENANCE
        dict(name="Oil & Filter Change",    category=ServiceCategory.MAINTENANCE, base_price=70,  est=30, desc="Engine oil and filter replacement"),
        dict(name="Tyre Rotation",          category=ServiceCategory.MAINTENANCE, base_price=40,  est=20, desc="Rotation of all four tyres"),
        dict(name="Brake Inspection",       category=ServiceCategory.MAINTENANCE, base_price=50,  est=25, desc="Full brake system check and report"),
        dict(name="AC Service",             category=ServiceCategory.MAINTENANCE, base_price=120, est=60, desc="AC system recharge and inspection"),
        dict(name="Battery Check & Replace",category=ServiceCategory.MAINTENANCE, base_price=90,  est=20, desc="Battery health test and replacement if needed"),
        # INSPECTION
        dict(name="Pre-Sale Inspection",    category=ServiceCategory.INSPECTION,  base_price=150, est=60, desc="Comprehensive 150-point vehicle inspection report"),
        dict(name="Annual Service Check",   category=ServiceCategory.INSPECTION,  base_price=100, est=45, desc="Routine service checkpoint for warranty"),
        # REPAIR
        dict(name="Minor Dent Repair",      category=ServiceCategory.REPAIR,      base_price=150, est=90,  desc="Paintless dent removal (PDR)"),
        dict(name="Windscreen Chip Repair", category=ServiceCategory.REPAIR,      base_price=80,  est=30,  desc="Resin injection for small chips"),
        dict(name="Scratch Touch-Up",       category=ServiceCategory.REPAIR,      base_price=120, est=60,  desc="Professional touch-up for minor scratches"),
    ]
    created = []
    for s in svcs:
        svc = Service(
            name=s["name"], category=s["category"], base_price=s["base_price"],
            estimated_duration_minutes=s["est"], description=s["desc"], is_active=True,
        )
        db.add(svc)
        created.append(svc)
    db.commit()
    for s in created:
        db.refresh(s)
    print(f"[OK] Created {len(created)} services")
    return created

def seed_vehicles():
    vehicles_data = [
        dict(plate="A 12345", make="Toyota",   model="Camry",      year=2022, color="White",  vehicle_type="sedan",      owner="Mohammed Al-Hajri",   phone="+974 5512 3401"),
        dict(plate="B 98765", make="Lexus",    model="LX600",      year=2023, color="Black",  vehicle_type="suv",        owner="Fatima Al-Qahtani",   phone="+974 5512 3402"),
        dict(plate="C 33210", make="Toyota",   model="Land Cruiser",year=2021, color="Silver", vehicle_type="suv",       owner="Ali Al-Naimi",         phone="+974 5512 3403"),
        dict(plate="D 77001", make="BMW",      model="X5",          year=2023, color="Blue",   vehicle_type="suv",       owner="Rashid Al-Kawari",     phone="+974 5512 3404"),
        dict(plate="E 44321", make="Mercedes", model="S-Class",     year=2024, color="Black",  vehicle_type="sedan",     owner="Noor Al-Mansoori",     phone="+974 5512 3405"),
        dict(plate="F 55678", make="Nissan",   model="Patrol",      year=2020, color="White",  vehicle_type="suv",       owner="Khalid Al-Fardan",     phone="+974 5512 3406"),
        dict(plate="G 11234", make="Porsche",  model="Cayenne",     year=2023, color="Red",    vehicle_type="suv",       owner="Sara Al-Jadaan",       phone="+974 5512 3407"),
        dict(plate="H 22567", make="GMC",      model="Yukon",       year=2022, color="Gray",   vehicle_type="suv",       owner="Hamad Al-Buainain",    phone="+974 5512 3408"),
        dict(plate="I 33890", make="Toyota",   model="Hilux",       year=2021, color="White",  vehicle_type="truck",     owner="Yusuf Al-Marri",       phone="+974 5512 3409"),
        dict(plate="J 44123", make="Ford",     model="F-150",       year=2022, color="Black",  vehicle_type="truck",     owner="Abdulla Al-Thani",     phone="+974 5512 3410"),
        dict(plate="K 55456", make="Kia",      model="Sportage",    year=2023, color="Silver", vehicle_type="suv",       owner="Maryam Al-Sulaiti",    phone="+974 5512 3411"),
        dict(plate="L 66789", make="Honda",    model="Civic",       year=2022, color="White",  vehicle_type="sedan",     owner="Omar Al-Mudahka",      phone="+974 5512 3412"),
        dict(plate="M 77012", make="Hyundai",  model="Sonata",      year=2021, color="Gray",   vehicle_type="sedan",     owner="Layla Al-Ansari",      phone="+974 5512 3413"),
        dict(plate="N 88345", make="Audi",     model="Q8",          year=2023, color="White",  vehicle_type="suv",       owner="Ibrahim Al-Sayed",     phone="+974 5512 3414"),
        dict(plate="O 99678", make="Range Rover",model="Sport",     year=2024, color="Black",  vehicle_type="suv",       owner="Sheikha Al-Misned",    phone="+974 5512 3415"),
        dict(plate="P 10234", make="Toyota",   model="Corolla",     year=2020, color="Blue",   vehicle_type="sedan",     owner="Faisal Al-Baker",      phone="+974 5512 3416"),
        dict(plate="Q 20567", make="Chevrolet",model="Tahoe",       year=2022, color="White",  vehicle_type="suv",       owner="Hessa Al-Jaber",       phone="+974 5512 3417"),
        dict(plate="R 30890", make="Lamborghini",model="Urus",      year=2023, color="Orange", vehicle_type="suv",       owner="Meshal Al-Rayyan",     phone="+974 5512 3418"),
        dict(plate="S 41123", make="Ferrari",  model="Roma",        year=2024, color="Red",    vehicle_type="sedan",     owner="Tamim Al-Shafi",       phone="+974 5512 3419"),
        dict(plate="T 51456", make="Mitsubishi",model="Pajero",     year=2020, color="Silver", vehicle_type="suv",       owner="Dana Al-Rumaihi",      phone="+974 5512 3420"),
    ]
    created = []
    for v in vehicles_data:
        veh = Vehicle(
            plate_number=v["plate"], make=v["make"], model=v["model"],
            year=v["year"], color=v["color"], vehicle_type=v["vehicle_type"],
            owner_name=v["owner"], owner_phone=v["phone"], plate_country="QA",
        )
        db.add(veh)
        created.append(veh)
    db.commit()
    for v in created:
        db.refresh(v)
    print(f"[OK] Created {len(created)} vehicles")
    return created

def seed_visits(vehicles, services, users):
    staff_members = [u for u in users.values() if u.role == UserRole.STAFF]
    admin = users["admin"]

    # Service categories for smart assignment
    wash_svcs     = [s for s in services if s.category == ServiceCategory.WASH]
    detail_svcs   = [s for s in services if s.category == ServiceCategory.DETAILING]
    polish_svcs   = [s for s in services if s.category == ServiceCategory.POLISH]
    maint_svcs    = [s for s in services if s.category == ServiceCategory.MAINTENANCE]
    repair_svcs   = [s for s in services if s.category == ServiceCategory.REPAIR]
    inspect_svcs  = [s for s in services if s.category == ServiceCategory.INSPECTION]

    # Visit templates: (service_groups, weight, min_stay_min, max_stay_min, min_price_mult, max_price_mult)
    visit_templates = [
        ([wash_svcs],                               35, 20,  60,  0.9, 1.0),
        ([wash_svcs, wash_svcs],                    15, 30,  90,  0.9, 1.1),
        ([wash_svcs, maint_svcs],                   15, 45,  120, 0.9, 1.0),
        ([detail_svcs],                             10, 90,  240, 0.95, 1.0),
        ([detail_svcs, polish_svcs],                5,  150, 300, 0.95, 1.05),
        ([polish_svcs],                             8,  100, 200, 0.9, 1.0),
        ([maint_svcs],                              7,  20,  60,  0.9, 1.0),
        ([inspect_svcs, maint_svcs],                3,  45,  90,  0.95, 1.0),
        ([repair_svcs, wash_svcs],                  2,  60,  180, 0.9, 1.1),
    ]

    # Weights for picking templates
    weights = [t[1] for t in visit_templates]

    # Generate visits over last 90 days
    now = datetime.utcnow()
    visit_count = 0
    visit_number_counter = 1000

    # Historical visits (last 90 days, completed)
    for day_offset in range(89, 0, -1):
        visit_date = now - timedelta(days=day_offset)
        # Fewer visits on Fridays (weekend in Qatar)
        is_friday = visit_date.weekday() == 4
        count_today = random.randint(2 if is_friday else 5, 6 if is_friday else 14)

        for _ in range(count_today):
            vehicle = random.choice(vehicles)
            template_idx = random.choices(range(len(visit_templates)), weights=weights)[0]
            svc_groups, _, min_stay, max_stay, price_low, price_high = visit_templates[template_idx]

            # Pick one service from each group
            selected_svcs = [random.choice(g) for g in svc_groups if g]

            # Entry time: business hours 7am-8pm Qatar time (UTC+3 → UTC-3h)
            hour = random.randint(7, 19)
            minute = random.randint(0, 59)
            entry = visit_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
            duration_m = random.randint(min_stay, max_stay)
            exit_t = entry + timedelta(minutes=duration_m)

            total_price = sum(s.base_price * random.uniform(price_low, price_high) for s in selected_svcs)
            total_price = round(total_price, 0)

            visit_number_counter += 1
            visit = Visit(
                visit_number=f"VT{visit_number_counter:05d}",
                vehicle_id=vehicle.id,
                created_by=admin.id,
                assigned_bay=random.randint(1, 5),
                entry_time=entry,
                exit_time=exit_t,
                duration_minutes=round(duration_m, 1),
                status=VisitStatus.COMPLETED,
                entry_method=random.choice([EntryMethod.AUTO_CAMERA, EntryMethod.MANUAL]),
                customer_name=vehicle.owner_name,
                customer_phone=vehicle.owner_phone,
                total_price=total_price,
                payment_status=random.choices(["paid", "unpaid"], weights=[90, 10])[0],
                payment_method=random.choice(["cash", "card", "knet"]),
                plate_confidence=round(random.uniform(0.88, 0.99), 2),
            )
            db.add(visit)
            db.flush()
            vehicle.total_visits = (vehicle.total_visits or 0) + 1

            # Add service items with staff
            time_cursor = entry
            for svc in selected_svcs:
                staff = random.choice(staff_members)
                svc_duration_m = int(svc.estimated_duration_minutes * random.uniform(0.7, 1.4))
                svc_start = time_cursor
                svc_end = svc_start + timedelta(minutes=svc_duration_m)
                db.add(ServiceItem(
                    visit_id=visit.id,
                    service_id=svc.id,
                    assigned_staff_id=staff.id,
                    price=round(svc.base_price * random.uniform(price_low, price_high), 0),
                    status="completed",
                    started_at=svc_start,
                    completed_at=svc_end,
                    actual_duration_minutes=round(svc_duration_m, 1),
                ))
                time_cursor = svc_end

            visit_count += 1

    db.commit()

    # Today's active visits (mix of statuses)
    today_visits = [
        dict(status=VisitStatus.IN_SERVICE, bay=1, mins_ago=45),
        dict(status=VisitStatus.IN_SERVICE, bay=2, mins_ago=20),
        dict(status=VisitStatus.WAITING,    bay=None, mins_ago=8),
        dict(status=VisitStatus.ON_HOLD,    bay=3, mins_ago=90),
        dict(status=VisitStatus.COMPLETED,  bay=4, mins_ago=180, dur=65),
        dict(status=VisitStatus.COMPLETED,  bay=5, mins_ago=120, dur=40),
    ]
    for tv in today_visits:
        vehicle = random.choice(vehicles)
        entry = now - timedelta(minutes=tv["mins_ago"])
        exit_t = entry + timedelta(minutes=tv.get("dur", 0)) if tv.get("dur") else None
        svc = random.choice(wash_svcs + maint_svcs)
        staff = random.choice(staff_members)

        visit_number_counter += 1
        visit = Visit(
            visit_number=f"VT{visit_number_counter:05d}",
            vehicle_id=vehicle.id,
            created_by=admin.id,
            assigned_bay=tv["bay"],
            entry_time=entry,
            exit_time=exit_t,
            duration_minutes=tv.get("dur"),
            status=tv["status"],
            entry_method=EntryMethod.MANUAL,
            customer_name=vehicle.owner_name,
            customer_phone=vehicle.owner_phone,
            total_price=svc.base_price,
            payment_status="unpaid" if tv["status"] != VisitStatus.COMPLETED else "paid",
        )
        db.add(visit)
        db.flush()
        vehicle.total_visits = (vehicle.total_visits or 0) + 1

        si_status = "in_progress" if tv["status"] == VisitStatus.IN_SERVICE else (
            "completed" if tv["status"] == VisitStatus.COMPLETED else "pending"
        )
        db.add(ServiceItem(
            visit_id=visit.id,
            service_id=svc.id,
            assigned_staff_id=staff.id,
            price=svc.base_price,
            status=si_status,
            started_at=entry if si_status != "pending" else None,
            completed_at=exit_t if si_status == "completed" else None,
            actual_duration_minutes=tv.get("dur"),
        ))
        visit_count += 1

    db.commit()
    print(f"[OK] Created {visit_count} visits (last 90 days + today's active)")

def main():
    print("\n=== CarTrack AI - Seeding Demo Data ===\n" + "-"*40)
    wipe()
    users = seed_users()
    seed_cameras()
    services = seed_services()
    vehicles = seed_vehicles()
    seed_visits(vehicles, services, users)
    print("\n" + "-"*40)
    print("SUCCESS: Demo data seeded!")
    print("\nLogin credentials:")
    print("   Admin:   admin   / demo1234")
    print("   Manager: manager / demo1234")
    print("   Staff:   khalid  / demo1234  (or omar, yusuf, hassan)")
    print("   Viewer:  viewer  / demo1234")
    print("\nApp: http://localhost:5173")
    db.close()

if __name__ == "__main__":
    main()
