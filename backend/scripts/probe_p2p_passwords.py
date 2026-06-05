"""Try P2P password variants until p2p-channel accepts (short probe)."""
from __future__ import annotations

import hashlib
import random
import subprocess
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "dh_p2p"
SERIAL = "BF0E4C7GAGB833C"
USER = "admin"
PLAIN = "a5013463"
SC = "L219E7D3"


def variants() -> list[tuple[str, str]]:
    md5p = hashlib.md5(PLAIN.encode()).hexdigest()
    return [
        ("plain", PLAIN),
        ("md5_upper", md5p.upper()),
        ("md5_lower", md5p.lower()),
        ("md5_user_plain", hashlib.md5(f"{USER}:{PLAIN}".encode()).hexdigest().upper()),
        ("security_code", SC),
        ("md5_sc_upper", hashlib.md5(SC.encode()).hexdigest().upper()),
    ]


def probe(pwd: str) -> str:
    r = subprocess.run(
        [sys.executable, str(VENDOR / "main_p2p.py"), SERIAL, "-t", "1", "-u", USER, "-p", pwd, "--local-port", "18650"],
        cwd=str(VENDOR),
        capture_output=True,
        text=True,
        timeout=20,
    )
    out = (r.stdout or "") + (r.stderr or "")
    if "Ready to connect" in out:
        return "OK"
    for tag in ("DevPwd_InvalidDigest", "DevPwd_InvalidSalt", "DevPwd_", "403 Forbidden", "Error:"):
        if tag in out:
            idx = out.find(tag)
            return out[idx : idx + 60].replace("\n", " ")
    return f"exit={r.returncode}"


def main() -> None:
    for name, pwd in variants():
        print(name, "->", probe(pwd))


if __name__ == "__main__":
    main()
