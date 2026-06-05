import sys, json, urllib.request, urllib.error
sys.path.insert(0, '.')

BASE = "http://localhost:8001"

def req(method, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            d = json.loads(resp.read())
            n = len(d) if isinstance(d, list) else "obj"
            return f"OK ({n})"
    except urllib.error.HTTPError as e:
        return f"ERR {e.code}"
    except Exception as e:
        return f"ERR {type(e).__name__}"

# Login
resp = json.loads(urllib.request.urlopen(
    urllib.request.Request(f"{BASE}/api/auth/login",
        data=json.dumps({"username":"admin","password":"demo1234"}).encode(),
        headers={"Content-Type":"application/json"}, method="POST"),
    timeout=5
).read())
t = resp["access_token"]
print(f"LOGIN OK - user={resp['user']['username']}, role={resp['user']['role']}")
print()

tests = [
    ("Dashboard",           "/api/analytics/dashboard"),
    ("Visits list",         "/api/visits"),
    ("Visits active",       "/api/visits/active"),
    ("Vehicles list",       "/api/vehicles"),
    ("Services list",       "/api/services"),
    ("Analytics summary",   "/api/analytics/summary?days=30"),
    ("Analytics daily",     "/api/analytics/daily?days=30"),
    ("Analytics by-svc",    "/api/analytics/by-service?days=30"),
    ("Analytics staff-kpi", "/api/analytics/staff-kpi?days=30"),
    ("Analytics seasonal",  "/api/analytics/seasonal"),
    ("Analytics svc-dur",   "/api/analytics/service-duration?days=30"),
    ("Analytics veh-type",  "/api/analytics/by-vehicle-type?days=30"),
    ("Cameras list",        "/api/cameras"),
    ("Users list",          "/api/users"),
    ("Audit log",           "/api/audit"),
    ("Settings",            "/api/settings"),
]

all_ok = True
for label, path in tests:
    result = req("GET", path, token=t)
    status = "OK" if result.startswith("OK") else "FAIL"
    if status != "OK":
        all_ok = False
    print(f"  {status}  {label:<25} {result}")

print()
print("ALL ENDPOINTS OK" if all_ok else "SOME ENDPOINTS FAILED")
