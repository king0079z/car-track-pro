from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.anpr import ANPRDetection
from ..models.service import ServiceItem, Service
from ..models.user import User
from ..models.vehicle import Vehicle
from ..models.visit import Visit, VisitStatus
from ..schemas.analytics import DashboardStats
from ..utils.auth import get_current_user
from ..utils.helpers import calculate_duration
from ..services.service_duration import infer_service_item_minutes, visit_service_counts as get_visit_service_counts
from ..utils.qatar_time import (
    date_key_qatar,
    hour_key_qatar,
    month_key_qatar,
    qatar_day_start_end,
    qatar_rolling_range_days,
    qatar_today,
    qatar_year_now,
)

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])


@router.get("/dashboard", response_model=DashboardStats)
def get_dashboard_stats(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    today = qatar_today()
    today_start, today_end = qatar_day_start_end(today)

    cars_today = db.query(Visit).filter(
        Visit.entry_time >= today_start,
        Visit.entry_time <= today_end
    ).count()

    cars_in_shop = db.query(Visit).filter(
        Visit.status.in_([VisitStatus.WAITING, VisitStatus.IN_SERVICE, VisitStatus.ON_HOLD])
    ).count()

    cars_completed = db.query(Visit).filter(
        Visit.entry_time >= today_start,
        Visit.status == VisitStatus.COMPLETED
    ).count()

    # Per-visit dwell: prefer stored duration_minutes; else derive from exit − entry
    # (completed visits only — matches "service time" / shop dwell, not ANPR track seconds).
    dwell_rows = (
        db.query(Visit.duration_minutes, Visit.entry_time, Visit.exit_time)
        .filter(
            Visit.entry_time >= today_start,
            Visit.entry_time <= today_end,
            Visit.status == VisitStatus.COMPLETED,
        )
        .all()
    )
    dwell_vals: list[float] = []
    for dm, et, xt in dwell_rows:
        if dm is not None:
            dwell_vals.append(float(dm))
        elif xt is not None and et is not None:
            dwell_vals.append(calculate_duration(et, xt))
    avg_duration = sum(dwell_vals) / len(dwell_vals) if dwell_vals else 0.0

    total_revenue = db.query(func.sum(Visit.total_price)).filter(
        Visit.entry_time >= today_start,
        Visit.status == VisitStatus.COMPLETED
    ).scalar() or 0.0

    # Bay utilization
    bay_data = db.query(Visit.assigned_bay, func.count(Visit.id)).filter(
        Visit.entry_time >= today_start,
        Visit.assigned_bay.isnot(None)
    ).group_by(Visit.assigned_bay).all()

    bay_util = {}
    for bay, count in bay_data:
        if bay:
            bay_util[str(bay)] = round(count / max(cars_today, 1) * 100, 1)

    # ── ANPR stats for today ──────────────────────────────────────────────────
    anpr_detected_today = db.query(func.count(ANPRDetection.id)).filter(
        ANPRDetection.detected_at >= today_start,
        ANPRDetection.detected_at <= today_end,
    ).scalar() or 0

    anpr_unique_today = db.query(func.count(func.distinct(ANPRDetection.plate))).filter(
        ANPRDetection.detected_at >= today_start,
        ANPRDetection.detected_at <= today_end,
    ).scalar() or 0

    # Detections without a linked visit (need attention)
    anpr_pending = db.query(func.count(ANPRDetection.id)).filter(
        ANPRDetection.detected_at >= today_start,
        ANPRDetection.detected_at <= today_end,
        ANPRDetection.visit_id.is_(None),
    ).scalar() or 0

    anpr_avg_speed = db.query(func.avg(ANPRDetection.speed_kmh)).filter(
        ANPRDetection.detected_at >= today_start,
        ANPRDetection.detected_at <= today_end,
        ANPRDetection.speed_kmh.isnot(None),
    ).scalar()

    return DashboardStats(
        total_cars_today=cars_today,
        cars_in_shop=cars_in_shop,
        cars_completed_today=cars_completed,
        avg_service_time_minutes=round(avg_duration, 1),
        total_revenue_today=round(total_revenue, 2),
        bay_utilization=bay_util,
        active_bays=len(bay_util),
        total_bays=5,
        anpr_detected_today=anpr_detected_today,
        anpr_unique_plates_today=anpr_unique_today,
        anpr_pending_visits=anpr_pending,
        anpr_avg_speed_today=round(float(anpr_avg_speed), 1) if anpr_avg_speed else None,
    )


@router.get("/report")
def get_analytics_report(
    start_date: date = Query(default=None),
    end_date: date = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not start_date:
        start_date = qatar_today() - timedelta(days=30)
    if not end_date:
        end_date = qatar_today()

    start_dt, _ = qatar_day_start_end(start_date)
    _, end_dt = qatar_day_start_end(end_date)

    visits = db.query(Visit).filter(
        Visit.entry_time >= start_dt,
        Visit.entry_time <= end_dt
    ).all()

    total_vehicles = len(visits)
    total_revenue = sum(v.total_price or 0 for v in visits)
    durations = [v.duration_minutes for v in visits if v.duration_minutes]
    avg_duration = sum(durations) / len(durations) if durations else 0

    # Daily breakdown
    daily = {}
    for v in visits:
        d = date_key_qatar(v.entry_time)
        if d not in daily:
            daily[d] = {"count": 0, "revenue": 0.0, "durations": []}
        daily[d]["count"] += 1
        daily[d]["revenue"] += v.total_price or 0
        if v.duration_minutes:
            daily[d]["durations"].append(v.duration_minutes)

    daily_breakdown = [
        {
            "date": d,
            "count": v["count"],
            "revenue": round(v["revenue"], 2),
            "avg_duration": round(sum(v["durations"]) / len(v["durations"]), 1) if v["durations"] else 0
        }
        for d, v in sorted(daily.items())
    ]

    # Bay utilization
    bay_data = {}
    for v in visits:
        if v.assigned_bay:
            b = v.assigned_bay
            if b not in bay_data:
                bay_data[b] = {"count": 0, "durations": []}
            bay_data[b]["count"] += 1
            if v.duration_minutes:
                bay_data[b]["durations"].append(v.duration_minutes)

    bay_utilization = [
        {
            "bay": bay,
            "cars_served": d["count"],
            "avg_service_time": round(sum(d["durations"]) / len(d["durations"]), 1) if d["durations"] else 0,
            "utilization_percent": round(d["count"] / max(total_vehicles, 1) * 100, 1)
        }
        for bay, d in bay_data.items()
    ]

    # Top vehicles
    plate_counts = {}
    for v in visits:
        p = v.vehicle.plate_number if v.vehicle else "Unknown"
        plate_counts[p] = plate_counts.get(p, 0) + 1
    top_vehicles = [{"plate": p, "visits": c} for p, c in sorted(plate_counts.items(), key=lambda x: -x[1])[:10]]

    return {
        "period_start": start_date.isoformat(),
        "period_end": end_date.isoformat(),
        "total_vehicles": total_vehicles,
        "total_revenue": round(total_revenue, 2),
        "avg_service_time": round(avg_duration, 1),
        "daily_breakdown": daily_breakdown,
        "bay_utilization": bay_utilization,
        "top_vehicles": top_vehicles,
        "return_rate": round(len([p for p, c in plate_counts.items() if c > 1]) / max(len(plate_counts), 1) * 100, 1)
    }


@router.get("/hourly")
def get_hourly_stats(
    target_date: date = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not target_date:
        target_date = qatar_today()

    start, end = qatar_day_start_end(target_date)

    visits = db.query(Visit).filter(Visit.entry_time >= start, Visit.entry_time <= end).all()

    hourly = {f"{h:02d}": {"count": 0, "revenue": 0.0, "anpr": 0} for h in range(24)}
    for v in visits:
        h = hour_key_qatar(v.entry_time)
        hourly[h]["count"] += 1
        hourly[h]["revenue"] += v.total_price or 0

    # Overlay ANPR detections per hour
    anpr_rows = db.query(ANPRDetection).filter(
        ANPRDetection.detected_at >= start,
        ANPRDetection.detected_at <= end,
    ).all()
    for a in anpr_rows:
        h = hour_key_qatar(a.detected_at)
        if h in hourly:
            hourly[h]["anpr"] += 1

    return [{"hour": h, "count": d["count"], "revenue": round(d["revenue"], 2), "anpr": d["anpr"]} for h, d in hourly.items()]


@router.get("/summary")
def get_summary(
    days: int = Query(default=7, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Summary KPIs for the last N days."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    visits = db.query(Visit).filter(
        Visit.entry_time >= start_dt,
        Visit.entry_time <= end_dt
    ).all()

    total_cars = len(visits)
    total_revenue = sum(v.total_price or 0 for v in visits)
    durations = [v.duration_minutes for v in visits if v.duration_minutes]
    avg_duration = sum(durations) / len(durations) if durations else 0

    # Peak hour
    hour_counts: dict = {}
    for v in visits:
        h = int(hour_key_qatar(v.entry_time))
        hour_counts[h] = hour_counts.get(h, 0) + 1
    peak_hour = max(hour_counts, key=lambda k: hour_counts[k]) if hour_counts else 0

    cars_completed = sum(1 for v in visits if v.status == VisitStatus.COMPLETED)

    return {
        "total_cars": total_cars,
        "cars_completed": cars_completed,
        "total_revenue": round(total_revenue, 2),
        "avg_duration_minutes": round(avg_duration, 1),
        "peak_hour": peak_hour,
        "days": days,
    }


@router.get("/daily")
def get_daily(
    days: int = Query(default=7, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Per-day breakdown for the last N days."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    visits = db.query(Visit).filter(
        Visit.entry_time >= start_dt,
        Visit.entry_time <= end_dt
    ).all()

    daily: dict = {}
    # Pre-fill all days so chart has no gaps
    today = qatar_today()
    for i in range(days):
        d = (today - timedelta(days=days - 1 - i)).isoformat()
        daily[d] = {"count": 0, "revenue": 0.0, "durations": []}

    for v in visits:
        d = date_key_qatar(v.entry_time)
        if d in daily:
            daily[d]["count"] += 1
            daily[d]["revenue"] += v.total_price or 0
            if v.duration_minutes:
                daily[d]["durations"].append(v.duration_minutes)

    return [
        {
            "date": d,
            "count": info["count"],
            "revenue": round(info["revenue"], 2),
            "avg_duration": round(sum(info["durations"]) / len(info["durations"]), 1) if info["durations"] else 0,
        }
        for d, info in daily.items()
    ]


@router.get("/by-service")
def get_by_service(
    days: int = Query(default=7, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Revenue and count breakdown by service type for the last N days."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    items = (
        db.query(ServiceItem, Service)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    agg: dict = {}
    for item, svc in items:
        key = svc.name
        if key not in agg:
            agg[key] = {"service_name": svc.name, "count": 0, "total_revenue": 0.0}
        agg[key]["count"] += 1
        agg[key]["total_revenue"] += item.price or svc.base_price or 0

    return sorted(agg.values(), key=lambda x: -x["total_revenue"])


@router.get("/service-duration")
def get_service_duration(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Average actual duration per service type (only completed items with timing data)."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    from sqlalchemy.orm import joinedload as jl
    items = (
        db.query(ServiceItem, Service)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .options(
            jl(ServiceItem.visit).joinedload(Visit.service_items).joinedload(ServiceItem.service)
        )
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    counts = get_visit_service_counts(db)

    agg: dict = {}
    for item, svc in items:
        key = svc.name
        if key not in agg:
            agg[key] = {
                "service_name": svc.name,
                "category": svc.category.value,
                "estimated_duration": svc.estimated_duration_minutes or 30,
                "count": 0,
                "actual_durations": [],
                "inferred_durations": [],
                "total_revenue": 0.0,
            }
        agg[key]["count"] += 1
        agg[key]["total_revenue"] += item.price or svc.base_price or 0

        minutes, source = infer_service_item_minutes(item, svc, item.visit, counts)
        if minutes is not None:
            bucket = "actual_durations" if source == "measured" else "inferred_durations"
            agg[key][bucket].append(minutes)

    result = []
    for k, v in agg.items():
        actual_avg    = round(sum(v["actual_durations"]) / len(v["actual_durations"]), 1) if v["actual_durations"] else None
        inferred_avg  = round(sum(v["inferred_durations"]) / len(v["inferred_durations"]), 1) if v["inferred_durations"] else None
        # Prefer actual; fall back to inferred; fall back to estimated
        best_avg = actual_avg or inferred_avg or v["estimated_duration"]
        result.append({
            "service_name": v["service_name"],
            "category": v["category"],
            "count": v["count"],
            "avg_actual_minutes": best_avg,
            "avg_actual_duration": best_avg,        # alias kept for backward compat
            "actual_count": len(v["actual_durations"]),
            "inferred_count": len(v["inferred_durations"]),
            "estimated_duration": v["estimated_duration"],
            "total_revenue": round(v["total_revenue"], 2),
            "efficiency": round(v["estimated_duration"] / best_avg * 100, 1) if best_avg and best_avg > 0 else 100,
            "data_quality": "measured" if v["actual_durations"] else ("shop_signature" if v["inferred_durations"] else "estimated"),
        })

    return sorted(result, key=lambda x: -(x["count"]))


@router.get("/service-duration-by-vehicle-type")
def get_service_duration_by_vehicle_type(
    days: int = Query(default=90, ge=1, le=365),
    vehicle_types: str = Query(default="sedan,suv", description="Comma-separated body types, e.g. sedan,suv"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Average minutes per service, split by vehicle body type (e.g. SUV vs Sedan).
    Powers the Fleet Intelligence service comparison view.
    """
    start_dt, end_dt = qatar_rolling_range_days(days)
    allowed = {t.strip().lower() for t in vehicle_types.split(",") if t.strip()}
    if not allowed:
        allowed = {"sedan", "suv"}

    from sqlalchemy.orm import joinedload as jl
    rows = (
        db.query(ServiceItem, Service, Vehicle)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .join(Vehicle, Visit.vehicle_id == Vehicle.id)
        .options(
            jl(ServiceItem.visit).joinedload(Visit.service_items).joinedload(ServiceItem.service)
        )
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    counts = get_visit_service_counts(db)

    def _type_bucket() -> dict:
        return {
            "count": 0,
            "measured": [],
            "inferred": [],
            "revenue": 0.0,
        }

    agg: dict[str, dict] = {}
    for item, svc, vehicle in rows:
        vtype = (vehicle.vehicle_type or "unknown").lower()
        if vtype not in allowed:
            continue
        key = svc.name
        if key not in agg:
            agg[key] = {
                "service_name": svc.name,
                "category": svc.category.value,
                "estimated_duration": svc.estimated_duration_minutes or 30,
                "total_jobs": 0,
                "total_revenue": 0.0,
                "by_type": {t: _type_bucket() for t in allowed},
            }
        agg[key]["total_jobs"] += 1
        price = item.price or svc.base_price or 0
        agg[key]["total_revenue"] += price
        agg[key]["by_type"][vtype]["count"] += 1
        agg[key]["by_type"][vtype]["revenue"] += price

        minutes, source = infer_service_item_minutes(item, svc, item.visit, counts)
        if minutes is not None:
            bucket = "measured" if source == "measured" else "inferred"
            agg[key]["by_type"][vtype][bucket].append(minutes)

    result = []
    for _name, v in agg.items():
        by_type_out: dict[str, dict] = {}
        for vtype in sorted(allowed):
            tb = v["by_type"].get(vtype) or _type_bucket()
            measured = tb["measured"]
            inferred = tb["inferred"]
            all_d = measured + inferred
            if all_d:
                avg = round(sum(all_d) / len(all_d), 1)
                quality = "measured" if measured and not inferred else (
                    "inferred" if inferred and not measured else "mixed"
                )
            else:
                avg = None
                quality = "estimated"
            by_type_out[vtype] = {
                "vehicle_type": vtype,
                "count": tb["count"],
                "avg_minutes": avg,
                "measured_count": len(measured),
                "inferred_count": len(inferred),
                "data_quality": quality,
                "total_revenue": round(tb["revenue"], 2),
            }

        sedan_avg = (by_type_out.get("sedan") or {}).get("avg_minutes")
        suv_avg = (by_type_out.get("suv") or {}).get("avg_minutes")
        delta = None
        if sedan_avg is not None and suv_avg is not None:
            delta = round(float(suv_avg) - float(sedan_avg), 1)

        result.append({
            "service_name": v["service_name"],
            "category": v["category"],
            "estimated_duration": v["estimated_duration"],
            "total_jobs": v["total_jobs"],
            "total_revenue": round(v["total_revenue"], 2),
            "by_type": by_type_out,
            "suv_vs_sedan_delta_minutes": delta,
        })

    return sorted(result, key=lambda x: -(x["total_jobs"]))


@router.get("/service-duration-jobs")
def get_service_duration_jobs(
    service_name: str = Query(..., min_length=1, description="Exact service catalogue name"),
    days: int = Query(default=90, ge=1, le=365),
    vehicle_types: str = Query(default="sedan,suv"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Individual service line items with full vehicle details (expand row in Fleet Intelligence)."""
    start_dt, end_dt = qatar_rolling_range_days(days)
    allowed = {t.strip().lower() for t in vehicle_types.split(",") if t.strip()}
    if not allowed:
        allowed = {"sedan", "suv"}

    from sqlalchemy.orm import joinedload as jl

    rows = (
        db.query(ServiceItem, Service, Vehicle, Visit)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .join(Vehicle, Visit.vehicle_id == Vehicle.id)
        .options(
            jl(ServiceItem.visit).joinedload(Visit.service_items).joinedload(ServiceItem.service)
        )
        .filter(
            Visit.entry_time >= start_dt,
            Visit.entry_time <= end_dt,
            Service.name == service_name,
        )
        .order_by(Visit.entry_time.desc())
        .all()
    )

    counts = get_visit_service_counts(db)
    jobs: list[dict] = []

    for item, svc, vehicle, visit in rows:
        vtype = (vehicle.vehicle_type or "unknown").lower()
        if vtype not in allowed:
            continue
        minutes, source = infer_service_item_minutes(item, svc, visit, counts)
        est = svc.estimated_duration_minutes or 30
        price = item.price or svc.base_price or 0
        vs_est = round(float(minutes) - est, 1) if minutes is not None else None

        jobs.append({
            "service_item_id": item.id,
            "visit_id": visit.id,
            "vehicle_id": vehicle.id,
            "plate_number": vehicle.plate_number,
            "make": vehicle.make or "",
            "model": vehicle.model or "",
            "year": vehicle.year,
            "color": vehicle.color or "",
            "vehicle_type": vtype,
            "vehicle_label": " ".join(
                p for p in [vehicle.make, vehicle.model, str(vehicle.year) if vehicle.year else ""] if p
            ).strip() or "—",
            "owner_name": vehicle.owner_name or "",
            "owner_phone": vehicle.owner_phone or "",
            "duration_minutes": round(float(minutes), 1) if minutes is not None else None,
            "duration_source": source if minutes is not None else "none",
            "estimated_duration": est,
            "vs_estimate_minutes": vs_est,
            "price": round(float(price), 2),
            "visit_date": visit.entry_time.isoformat() if visit.entry_time else None,
            "visit_status": visit.status.value if visit.status else "",
            "item_status": item.status or "pending",
        })

    return {
        "service_name": service_name,
        "days": days,
        "vehicle_types": sorted(allowed),
        "total_jobs": len(jobs),
        "jobs": jobs,
    }

@router.get("/by-vehicle-type")
def get_by_vehicle_type(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Average visit duration and revenue by vehicle type."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    visits = (
        db.query(Visit, Vehicle)
        .join(Vehicle, Visit.vehicle_id == Vehicle.id)
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    agg: dict = {}
    for visit, vehicle in visits:
        vtype = (vehicle.vehicle_type or "unknown").lower()
        if vtype not in agg:
            agg[vtype] = {"vehicle_type": vtype, "count": 0, "durations": [], "revenue": 0.0}
        agg[vtype]["count"] += 1
        agg[vtype]["revenue"] += visit.total_price or 0
        if visit.duration_minutes:
            agg[vtype]["durations"].append(visit.duration_minutes)

    result = []
    for vtype, v in agg.items():
        result.append({
            "vehicle_type": vtype,
            "count": v["count"],
            "avg_duration_minutes": round(sum(v["durations"]) / len(v["durations"]), 1) if v["durations"] else 0,
            "total_revenue": round(v["revenue"], 2),
            "avg_revenue": round(v["revenue"] / v["count"], 2) if v["count"] else 0,
        })

    return sorted(result, key=lambda x: -x["count"])


@router.get("/staff-kpi")
def get_staff_kpi(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Staff performance KPIs: services completed, revenue, avg duration."""
    start_dt, end_dt = qatar_rolling_range_days(days)

    items = (
        db.query(ServiceItem, Service, User)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(User, ServiceItem.assigned_staff_id == User.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    # Also count visits created by staff
    agg: dict = {}
    for item, svc, staff in items:
        sid = staff.id
        if sid not in agg:
            agg[sid] = {
                "staff_id": staff.id,
                "staff_name": staff.full_name,
                "username": staff.username,
                "services_count": 0,
                "durations": [],
                "revenue": 0.0,
                "service_breakdown": {},
            }
        agg[sid]["services_count"] += 1
        agg[sid]["revenue"] += item.price or 0
        if item.actual_duration_minutes:
            agg[sid]["durations"].append(item.actual_duration_minutes)
        cat = svc.category.value
        agg[sid]["service_breakdown"][cat] = agg[sid]["service_breakdown"].get(cat, 0) + 1

    result = []
    for staff_id, v in agg.items():
        avg_d = round(sum(v["durations"]) / len(v["durations"]), 1) if v["durations"] else None
        result.append({
            "staff_id": v["staff_id"],
            "staff_name": v["staff_name"],
            "username": v["username"],
            "services_count": v["services_count"],
            "total_revenue": round(v["revenue"], 2),
            "avg_service_duration": avg_d,
            "service_breakdown": v["service_breakdown"],
        })

    return sorted(result, key=lambda x: -x["services_count"])


@router.get("/seasonal")
def get_seasonal(
    year: int = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Monthly revenue and car count for the year (seasonal analysis)."""
    if not year:
        year = qatar_year_now()

    start_dt, _ = qatar_day_start_end(date(year, 1, 1))
    _, end_dt = qatar_day_start_end(date(year, 12, 31))

    visits = db.query(Visit).filter(
        Visit.entry_time >= start_dt,
        Visit.entry_time <= end_dt
    ).all()

    months = {i: {"month": i, "month_name": date(year, i, 1).strftime("%b"), "count": 0, "revenue": 0.0, "durations": []} for i in range(1, 13)}

    for v in visits:
        m = month_key_qatar(v.entry_time)
        months[m]["count"] += 1
        months[m]["revenue"] += v.total_price or 0
        if v.duration_minutes:
            months[m]["durations"].append(v.duration_minutes)

    return [
        {
            "month": m["month"],
            "month_name": m["month_name"],
            "count": m["count"],
            "revenue": round(m["revenue"], 2),
            "avg_duration": round(sum(m["durations"]) / len(m["durations"]), 1) if m["durations"] else 0,
        }
        for m in months.values()
    ]


@router.get("/by-vehicle-model")
def get_by_vehicle_model(
    days: int = Query(default=90, ge=1, le=730),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Per-model breakdown: avg duration, revenue, service counts."""
    from sqlalchemy import func as sqlfunc

    start_dt, end_dt = qatar_rolling_range_days(days)

    rows = (
        db.query(Visit, Vehicle)
        .join(Vehicle, Visit.vehicle_id == Vehicle.id)
        .filter(Visit.entry_time >= start_dt, Visit.entry_time <= end_dt)
        .all()
    )

    agg: dict = {}
    for visit, vehicle in rows:
        key = f"{vehicle.make or 'Unknown'} {vehicle.model or ''}".strip()
        vtype = (vehicle.vehicle_type or "sedan").lower()
        if key not in agg:
            agg[key] = {
                "make": vehicle.make or "Unknown",
                "model": vehicle.model or "",
                "vehicle_type": vtype,
                "count": 0,
                "durations": [],
                "revenue": 0.0,
                "service_counts": [],
            }
        agg[key]["count"] += 1
        agg[key]["revenue"] += visit.total_price or 0
        if visit.duration_minutes:
            agg[key]["durations"].append(visit.duration_minutes)
        agg[key]["service_counts"].append(len(visit.service_items) if visit.service_items else 0)

    result = []
    for key, v in agg.items():
        result.append({
            "label": key,
            "make": v["make"],
            "model": v["model"],
            "vehicle_type": v["vehicle_type"],
            "count": v["count"],
            "avg_duration_minutes": round(sum(v["durations"]) / len(v["durations"]), 1) if v["durations"] else 0,
            "total_revenue": round(v["revenue"], 2),
            "avg_revenue": round(v["revenue"] / v["count"], 2) if v["count"] else 0,
            "avg_services": round(sum(v["service_counts"]) / len(v["service_counts"]), 1) if v["service_counts"] else 0,
        })

    return sorted(result, key=lambda x: -x["count"])
