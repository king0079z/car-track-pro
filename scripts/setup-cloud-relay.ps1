# CarTrack Cloud Relay - point this site PC at your VPS and start publishing.
# Run AFTER MediaMTX is up on your VPS (deploy/relay/setup-vps.sh).
#
# Usage:
#   .\scripts\setup-cloud-relay.ps1 -VpsIp 1.2.3.4 -RelayPass "your-strong-pass"
#
# This keeps LAN ANPR working locally AND publishes the camera to your VPS for
# remote viewing. The PC must stay on the same Wi-Fi as the camera and stay on.

param(
  [Parameter(Mandatory = $true)] [string] $VpsIp,
  [Parameter(Mandatory = $true)] [string] $RelayPass,
  [string] $RelayUser = "cartrack",
  [string] $Path = "hero-a1",
  [string] $ApiBase = "http://127.0.0.1:8001",
  [string] $AdminUser = "admin",
  [string] $AdminPass = "demo1234"
)

$ErrorActionPreference = "Stop"
$relayUrl = "rtsp://{0}:{1}@{2}:8554/{3}" -f $RelayUser, $RelayPass, $VpsIp, $Path

Write-Host "CarTrack Cloud Relay setup" -ForegroundColor Cyan
Write-Host "  VPS publish/view: rtsp://${RelayUser}:***@${VpsIp}:8554/${Path}"
Write-Host ""

# Login
$login = Invoke-RestMethod -Uri "$ApiBase/api/auth/login" -Method Post -ContentType "application/json" `
  -Body (@{ username = $AdminUser; password = $AdminPass } | ConvertTo-Json)
$token = $login.access_token
$headers = @{ Authorization = "Bearer $token" }

# Save relay URLs (keeps existing serial/host/password). Connection stays usable for LAN too.
$patch = @{
  cartrack_relay_publish_url = $relayUrl
  cartrack_relay_view_url    = $relayUrl
} | ConvertTo-Json
Invoke-RestMethod -Uri "$ApiBase/api/cameras/dahua/hero-a1" -Method Patch -Headers $headers `
  -ContentType "application/json" -Body $patch | Out-Null
Write-Host "Saved relay URLs to camera config." -ForegroundColor Green

# Start the relay (LAN RTSP -> VPS)
try {
  $res = Invoke-RestMethod -Uri "$ApiBase/api/cameras/dahua/hero-a1/cartrack-relay/start" -Method Post -Headers $headers
  if ($res.running -or $res.ok) {
    Write-Host "Relay started - publishing LAN stream to your VPS." -ForegroundColor Green
  } else {
    Write-Host "Relay start returned: $($res | ConvertTo-Json -Compress)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "Relay start failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check: camera LAN IP is reachable, and the VPS RTSP port 8554 is open." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Verify from anywhere (VLC):  rtsp://${RelayUser}:${RelayPass}@${VpsIp}:8554/${Path}" -ForegroundColor Cyan
Write-Host "Browser preview (HLS):       http://${VpsIp}:8888/${Path}" -ForegroundColor Cyan
