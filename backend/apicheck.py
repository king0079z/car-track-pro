"""Quick API check - tests every page endpoint with a real token."""
import sys, urllib.request, urllib.parse, json
sys.path.insert(0, '.')

BASE = "http://localhost:8001"

def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def get(path, token):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
            count = len(data) if isinstance(data, list) else (data.get('total_cars') or data.get('count') or '(object)')
            return f"OK  ({count} items)"
    except Exception as e:
        code = getattr(getattr(e, 'code', None), '__str__', lambda: str(e))()
        return f"ERR {e}"

# Login
resp = post("/api/auth/login", {"username": "admin", "password": "demo1234"})
token = resp["access_token"]
print(f"LOGIN: OK  (token received, user={resp['user']['username']})")
print()

endpoints = [
    ("Dashboard stats",      "/api/analytics/dashboard"),
    ("Dashboard hourly",     "/api/analytics/hourly"),
    ("Visits list",          "/api/visits"),
    ("Active visits",        "/api/visits/active"),
    ("Vehicles list",        "/api/vehicles"),
    ("Vehicle history",      "/api/vehicles/1/history"),
    ("Services list",        "/api/services"),
    ("Analytics summary",    "/api/analytics/summary?days=30"),
    ("Analytics daily",      "/api/analytics/daily?days=30"),
    ("Analytics by-service", "/api/analytics/by-service?days=30"),
    ("Analytics staff-kpi",  "/api/analytics/staff-kpi?days=30"),
    ("Analytics seasonal",   "/api/analytics/seasonal"),
    ("Analytics svc-dur",    "/api/analytics/service-duration?days=30"),
    ("Analytics veh-type",   "/api/analytics/by-vehicle-type?days=30"),
    ("Cameras list",         "/api/cameras"),
    ("Users list",           "/api/users"),
    ("Audit log",            "/api/audit"),
    ("Settings",             "/api/settings"),
]

print(f"{'ENDPOINT':<25} | RESULT")
print("-" * 55)
for label, path in endpoints:
    result = get(path, token)
    print(f"{label:<25} | {result}")
