"""
WhatsApp customer notifications via the Meta WhatsApp Business Cloud API.

When a work order is completed/checked out, the customer gets a WhatsApp
message that their vehicle is ready. Configuration is env-driven (no new
dependencies — plain HTTPS like the Easy4IP client):

  WHATSAPP_ENABLED=true
  WHATSAPP_ACCESS_TOKEN=EAAG...           (permanent System User token)
  WHATSAPP_PHONE_NUMBER_ID=1234567890     (from Meta developer console)
  WHATSAPP_TEMPLATE_NAME=work_order_ready (optional, see below)
  WHATSAPP_DEFAULT_COUNTRY_CODE=974       (prefix for local numbers, Qatar)

Template vs free-form: WhatsApp only delivers free-form ("text") messages
inside a 24h customer-service window. For business-initiated notifications
you should create an approved template (e.g. ``work_order_ready`` with two
{{params}}: customer name, plate). If WHATSAPP_TEMPLATE_NAME is set we send
the template; otherwise we attempt a free-form text message (works while the
customer has messaged you within 24h, and in the sandbox).

The runtime on/off switch is the ``whatsapp_notifications`` toggle in the
app Settings page; sends run in a daemon thread so the API never blocks.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any
from urllib import request as _urlrequest
from urllib.error import HTTPError, URLError

from ..config import settings

_log = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.facebook.com"
_HTTP_TIMEOUT = 20.0


def _runtime_enabled() -> bool:
    """Admin toggle in settings.json (defaults to on when creds exist)."""
    try:
        from ..routers.settings import _load

        return bool(_load().get("whatsapp_notifications", True))
    except Exception:
        return True


def is_configured() -> bool:
    if bool(getattr(settings, "WHATSAPP_DRY_RUN", False)):
        return True
    return bool(
        getattr(settings, "WHATSAPP_ENABLED", False)
        and str(getattr(settings, "WHATSAPP_ACCESS_TOKEN", "") or "").strip()
        and str(getattr(settings, "WHATSAPP_PHONE_NUMBER_ID", "") or "").strip()
    )


def normalize_msisdn(phone: str | None) -> str | None:
    """Normalize a phone number to international digits (no +, no spaces).
    Local numbers get the default country code (Qatar: 974, 8-digit local)."""
    raw = str(phone or "").strip()
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", raw)
    if not digits:
        return None
    cc = re.sub(r"[^\d]", "", str(getattr(settings, "WHATSAPP_DEFAULT_COUNTRY_CODE", "974") or ""))
    if raw.startswith("+") or raw.startswith("00"):
        return digits.lstrip("0") if raw.startswith("00") else digits
    if cc and digits.startswith(cc) and len(digits) > len(cc) + 4:
        return digits
    if cc and len(digits) <= 8:
        return f"{cc}{digits}"
    return digits


def _post_graph(payload: dict[str, Any]) -> dict[str, Any]:
    version = str(getattr(settings, "WHATSAPP_API_VERSION", "v22.0") or "v22.0").strip()
    phone_id = str(getattr(settings, "WHATSAPP_PHONE_NUMBER_ID", "") or "").strip()
    token = str(getattr(settings, "WHATSAPP_ACCESS_TOKEN", "") or "").strip()
    url = f"{_GRAPH_BASE}/{version}/{phone_id}/messages"
    req = _urlrequest.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with _urlrequest.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")[:500]
        except Exception:
            pass
        raise RuntimeError(f"WhatsApp API HTTP {exc.code}: {body}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"WhatsApp API network error: {exc}") from exc


def send_text(phone: str, text: str) -> dict[str, Any]:
    """Free-form text message (24h customer-service window / sandbox)."""
    msisdn = normalize_msisdn(phone)
    if not msisdn:
        raise RuntimeError("No valid phone number")
    return _post_graph({
        "messaging_product": "whatsapp",
        "to": msisdn,
        "type": "text",
        "text": {"preview_url": False, "body": text[:4000]},
    })


def send_template(phone: str, template: str, params: list[str], *, lang: str = "en") -> dict[str, Any]:
    """Approved template message (business-initiated, always deliverable)."""
    msisdn = normalize_msisdn(phone)
    if not msisdn:
        raise RuntimeError("No valid phone number")
    return _post_graph({
        "messaging_product": "whatsapp",
        "to": msisdn,
        "type": "template",
        "template": {
            "name": template,
            "language": {"code": lang},
            "components": [{
                "type": "body",
                "parameters": [{"type": "text", "text": str(p)[:120]} for p in params],
            }] if params else [],
        },
    })


def _business_name() -> str:
    try:
        from ..routers.settings import _load

        return str(_load().get("business_name") or "CarTrack Pro")
    except Exception:
        return "CarTrack Pro"


def _fmt_duration_minutes(mins: float | int | None) -> str:
    if mins is None or mins <= 0:
        return "—"
    m = int(round(float(mins)))
    if m < 60:
        return f"{m} min"
    h, r = divmod(m, 60)
    return f"{h}h {r}m" if r else f"{h}h"


def _compose_completion_text(
    *,
    customer_name: str,
    plate: str,
    visit_number: str,
    services: list[str],
    total: float | None,
    duration_minutes: float | int | None = None,
    entry_label: str = "",
    exit_label: str = "",
    bay: int | None = None,
    payment_status: str = "",
    service_lines: list[str] | None = None,
) -> str:
    """Full work-order receipt suitable for WhatsApp (Markdown-style bold)."""
    shop = _business_name()
    lines = [
        f"*{shop} — Work order complete*",
        "",
        f"Hello {customer_name or 'valued customer'},",
        "",
        f"Your vehicle *{plate}* is ready for pickup.",
        "",
        f"*Work order:* {visit_number}",
    ]
    if bay:
        lines.append(f"*Bay:* {bay}")
    if entry_label:
        lines.append(f"*Arrived:* {entry_label}")
    if exit_label:
        lines.append(f"*Completed:* {exit_label}")
    if duration_minutes:
        lines.append(f"*Time in shop:* {_fmt_duration_minutes(duration_minutes)}")
    lines.append("")
    if service_lines:
        lines.append("*Services:*")
        lines.extend(service_lines[:12])
    elif services:
        lines.append("*Services:* " + ", ".join(services[:8]))
    lines.append("")
    if total is not None:
        lines.append(f"*Total:* QAR {total:,.0f}")
    if payment_status:
        lines.append(f"*Payment:* {payment_status.replace('_', ' ').title()}")
    lines += ["", f"Thank you for choosing {shop}!"]
    return "\n".join(lines)


def _load_visit_for_notify(db, visit_id: int):
    from sqlalchemy.orm import joinedload

    from ..models.service import ServiceItem
    from ..models.visit import Visit

    return (
        db.query(Visit)
        .options(
            joinedload(Visit.vehicle),
            joinedload(Visit.service_items).joinedload(ServiceItem.service),
            joinedload(Visit.service_items).joinedload(ServiceItem.assigned_staff),
        )
        .filter(Visit.id == visit_id)
        .first()
    )


def _visit_whatsapp_payload(visit) -> tuple[str | None, str, dict[str, Any]]:
    """Returns (phone, customer_name, kwargs for _compose_completion_text)."""
    phone = visit.customer_phone or (visit.vehicle.owner_phone if visit.vehicle else None)
    customer = visit.customer_name or (visit.vehicle.owner_name if visit.vehicle else "") or ""
    plate = visit.vehicle.plate_number if visit.vehicle else "your vehicle"

    service_names: list[str] = []
    service_lines: list[str] = []
    for si in visit.service_items or []:
        name = si.service.name if si.service else "Service"
        service_names.append(name)
        price = si.price if si.price is not None else 0
        dur = si.actual_duration_minutes
        if dur is None and si.started_at and si.completed_at:
            dur = max(1, int((si.completed_at - si.started_at).total_seconds() // 60))
        line = f"• {name} — QAR {price:,.0f}"
        if dur:
            line += f" ({_fmt_duration_minutes(dur)})"
        service_lines.append(line)

    entry_label = ""
    exit_label = ""
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(getattr(settings, "BUSINESS_TIMEZONE", "Asia/Qatar") or "Asia/Qatar")
    except Exception:
        tz = None

    def _fmt_dt(dt) -> str:
        if not dt:
            return ""
        try:
            if tz:
                local = dt.astimezone(tz) if dt.tzinfo else dt.replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
                return local.strftime("%d %b %Y, %I:%M %p")
        except Exception:
            pass
        return dt.strftime("%d %b %Y, %H:%M")

    entry_label = _fmt_dt(visit.entry_time)
    exit_label = _fmt_dt(visit.exit_time)

    kwargs = {
        "customer_name": customer,
        "plate": plate,
        "visit_number": visit.visit_number,
        "services": service_names,
        "total": visit.total_price,
        "duration_minutes": visit.duration_minutes,
        "entry_label": entry_label,
        "exit_label": exit_label,
        "bay": visit.assigned_bay,
        "payment_status": str(visit.payment_status or "unpaid"),
        "service_lines": service_lines,
    }
    return normalize_msisdn(phone), customer, kwargs


def send_work_order_completion(visit_id: int, *, force: bool = False) -> dict[str, Any]:
    """Send (or resend) the completion WhatsApp. Returns status dict for API responses."""
    if not is_configured():
        return {"ok": False, "error": "WhatsApp is not configured on the server (WHATSAPP_* env vars)"}
    if not _runtime_enabled():
        return {"ok": False, "error": "WhatsApp notifications are disabled in Settings"}

    from datetime import UTC, datetime

    from ..database import SessionLocal

    db = SessionLocal()
    try:
        visit = _load_visit_for_notify(db, visit_id)
        if visit is None:
            return {"ok": False, "error": "Visit not found"}
        if visit.status.value != "completed":
            return {"ok": False, "error": "Work order must be completed before sending WhatsApp"}
        if visit.whatsapp_notified_at is not None and not force:
            return {"ok": False, "error": "WhatsApp already sent for this visit"}

        phone, customer, text_kwargs = _visit_whatsapp_payload(visit)
        if not phone:
            return {"ok": False, "error": "No customer phone number on this work order"}

        plate = text_kwargs["plate"]
        template = str(getattr(settings, "WHATSAPP_TEMPLATE_NAME", "") or "").strip()
        use_full_report = not template or bool(getattr(settings, "WHATSAPP_FULL_REPORT", True))
        text = _compose_completion_text(**text_kwargs)

        if bool(getattr(settings, "WHATSAPP_DRY_RUN", False)):
            _log.info(
                "WhatsApp DRY RUN for visit %s → %s\n%s",
                visit.visit_number,
                phone,
                text,
            )
            print(f"\n--- WhatsApp DRY RUN -> +{phone} ---\n{text}\n---\n", flush=True)
            visit.whatsapp_notified_at = datetime.now(UTC)
            db.commit()
            return {"ok": True, "dry_run": True, "phone": phone, "preview": text[:500]}

        try:
            if template and not use_full_report:
                result = send_template(phone, template, [customer or "customer", plate])
            else:
                result = send_text(phone, text)
        except RuntimeError as exc:
            _log.warning("WhatsApp send failed for visit %s: %s", visit_id, exc)
            return {"ok": False, "error": str(exc)}

        visit.whatsapp_notified_at = datetime.now(UTC)
        db.commit()
        msg_id = ((result.get("messages") or [{}])[0]).get("id")
        _log.info("WhatsApp completion sent for %s to %s (msg id %s)", visit.visit_number, phone, msg_id)
        return {"ok": True, "message_id": msg_id, "phone": phone}
    except Exception as exc:
        _log.exception("WhatsApp send failed for visit %s", visit_id)
        return {"ok": False, "error": str(exc)}
    finally:
        db.close()


def notify_work_order_completed(visit_id: int) -> None:
    """Fire-and-forget: send the completion message for a visit in a daemon
    thread. Safe to call from request handlers; no-ops when not configured,
    runtime-disabled, or already sent (``visit.whatsapp_notified_at``)."""
    if not is_configured() or not _runtime_enabled():
        return

    def _worker() -> None:
        send_work_order_completion(visit_id, force=False)

    threading.Thread(target=_worker, name=f"whatsapp-notify-{visit_id}", daemon=True).start()


def status_summary() -> dict[str, Any]:
    """For the Settings page: shows whether WhatsApp is wired up."""
    return {
        "configured": is_configured(),
        "enabled_env": bool(getattr(settings, "WHATSAPP_ENABLED", False)),
        "runtime_toggle": _runtime_enabled(),
        "uses_template": bool(str(getattr(settings, "WHATSAPP_TEMPLATE_NAME", "") or "").strip()),
        "full_report": bool(getattr(settings, "WHATSAPP_FULL_REPORT", True)),
        "dry_run": bool(getattr(settings, "WHATSAPP_DRY_RUN", False)),
        "default_country_code": str(getattr(settings, "WHATSAPP_DEFAULT_COUNTRY_CODE", "974")),
    }
