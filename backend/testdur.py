import sys, json, urllib.request
sys.path.insert(0,'.')
BASE = 'http://localhost:8001'
token = json.loads(urllib.request.urlopen(
    urllib.request.Request(f'{BASE}/api/auth/login',
        data=json.dumps({'username':'admin','password':'demo1234'}).encode(),
        headers={'Content-Type':'application/json'}, method='POST'), timeout=5).read()
)['access_token']

r = urllib.request.urlopen(
    urllib.request.Request(f'{BASE}/api/analytics/service-duration?days=90',
        headers={'Authorization': f'Bearer {token}'}), timeout=15)
data = json.loads(r.read())
print(f'Got {len(data)} services')
for d in data[:6]:
    name = d.get('service_name','?')
    avg  = d.get('avg_actual_minutes', d.get('avg_actual_duration'))
    cnt  = d.get('count',0)
    qual = d.get('data_quality','?')
    print(f'  {name}: avg={avg}min, count={cnt}, quality={qual}')
