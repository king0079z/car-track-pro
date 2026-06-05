from pydantic import BaseModel
from typing import List, Dict, Optional
from datetime import date


class DashboardStats(BaseModel):
    total_cars_today: int
    cars_in_shop: int
    cars_completed_today: int
    avg_service_time_minutes: float
    total_revenue_today: float
    peak_hour: Optional[str] = None
    bay_utilization: Dict[str, float] = {}
    active_bays: int
    total_bays: int

    # ANPR-enriched fields
    anpr_detected_today: int = 0        # distinct plates seen by video analysis today
    anpr_unique_plates_today: int = 0   # unique plate strings (may differ from detected count)
    anpr_pending_visits: int = 0        # detections with no visit yet (actionable)
    anpr_avg_speed_today: Optional[float] = None  # km/h average for today


class HourlyData(BaseModel):
    hour: str
    count: int
    revenue: float


class DailyData(BaseModel):
    date: str
    count: int
    revenue: float
    avg_duration: float


class ServiceBreakdown(BaseModel):
    service: str
    count: int
    revenue: float
    avg_duration: float


class BayUtilization(BaseModel):
    bay: int
    utilization_percent: float
    cars_served: int
    avg_service_time: float


class AnalyticsReport(BaseModel):
    period_start: str
    period_end: str
    total_vehicles: int
    total_revenue: float
    avg_service_time: float
    hourly_breakdown: List[HourlyData] = []
    daily_breakdown: List[DailyData] = []
    service_breakdown: List[ServiceBreakdown] = []
    bay_utilization: List[BayUtilization] = []
    top_vehicles: List[dict] = []
    return_rate: float
