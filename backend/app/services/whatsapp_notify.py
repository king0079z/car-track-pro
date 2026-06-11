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


def _compose_completion_text(
    *, customer_name: str, plate: str, visit_number: str, services: list[str], total: float | None
) -> str:
    shop = _business_name()
    lines = [
        f"Hello {customer_name or 'valued customer'},",
        "",
        f"Good news — the work on your vehicle *{plate}* is complete and it is ready for pickup.",
        "",
        f"Work order: {visit_number}",
    ]
    if services:
        lines.append("Services: " + ", ".join(services[:6]))
    if total:
        lines.append(f"Total: QAR {total:,.0f}")
    lines += ["", f"Thank you for choosing {shop}!"]
    return "\n".join(lines)


def notify_work_order_completed(visit_id: int) -> None:
    """Fire-and-forget: send the completion message for a visit in a daemon
    thread. Safe to call from request handlers; no-ops when not configured,
    runtime-disabled, or already sent (``visit.whatsapp_notified_at``)."""
    if not is_configured() or not _runtime_enabled():
        return

    def _worker() -> None:
        from datetime import UTC, datetime

        from ..database import SessionLocal
        from ..models.visit import Visit

        db = SessionLocal()
        try:
            visit = db.query(Visit).filter(Visit.id == visit_id).first()
            if visit is None or visit.whatsapp_notified_at is not None:
                return
            phone = visit.customer_phone or (visit.vehicle.owner_phone if visit.vehicle else None)
            if not normalize_msisdn(phone):
                _log.info("WhatsApp skip for visit %s: no customer phone", visit_id)
                return
            plate = visit.vehicle.plate_number if visit.vehicle else "your vehicle"
            customer = visit.customer_name or (visit.vehicle.owner_name if visit.vehicle else "") or ""
            services = [
                si.service.name for si in (visit.service_items or [])
                if si.service and si.service.name
            ]
            template = str(getattr(settings, "WHATSAPP_TEMPLATE_NAME", "") or "").strip()
            try:
                if template:
                    result = send_template(phone, template, [customer or "customer", plate])
                else:
                    text = _compose_completion_text(
                        customer_name=customer,
                        plate=plate,
                        visit_number=visit.visit_number,
                        services=services,
                        total=visit.total_price,
                    )
                    result = send_text(phone, text)
            except RuntimeError as exc:
                _log.warning("WhatsApp send failed for visit %s: %s", visit_id, exc)
                return
            visit.whatsapp_notified_at = datetime.now(UTC)
            db.commit()
            _log.info(
                "WhatsApp completion sent for %s to %s (msg id %s)",
                visit.visit_number,
                normalize_msisdn(phone),
                ((result.get("messages") or [{}])[0]).get("id"),
            )
        except Exception:
            _log.exception("WhatsApp notify worker failed for visit %s", visit_id)
        finally:
            db.close()

    threading.Thread(target=_worker, name=f"whatsapp-notify-{visit_id}", daemon=True).start()


def status_summary() -> dict[str, Any]:
    """For the Settings page: shows whether WhatsApp is wired up."""
    return {
        "configured": is_configured(),
        "enabled_env": bool(getattr(settings, "WHATSAPP_ENABLED", False)),
        "runtime_toggle": _runtime_enabled(),
        "uses_template": bool(str(getattr(settings, "WHATSAPP_TEMPLATE_NAME", "") or "").strip()),
        "default_country_code": str(getattr(settings, "WHATSAPP_DEFAULT_COUNTRY_CODE", "974")),
    }
