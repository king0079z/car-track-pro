"""Compare P2P key derivation: global salt vs device salt in get_key."""
from __future__ import annotations

import hashlib
import random
import sys
from pathlib import Path

vendor = Path(__file__).resolve().parents[1] / "vendor" / "dh_p2p"
sys.path.insert(0, str(vendor))

from helpers import (  # noqa: E402
    MAIN_PORT,
    MAIN_SERVER,
    UDP,
    extract_randsalt_from_info,
    get_auth,
    get_enc,
    get_key,
    get_nonce,
    RANDSALT,
)

SERIAL = "BF0E4C7GAGB833C"
USER = "admin"
PWD = "a5013463"


def try_mode(label: str, *, key_salt: str, auth_salt: str) -> str:
    main_remote = UDP(MAIN_SERVER, MAIN_PORT, debug=False)
    main_remote.request("/probe/p2psrv")
    res = main_remote.request(f"/online/p2psrv/{SERIAL}")
    p2psrv_server, p2psrv_port = res["data"]["body"]["US"].split(":")
    p2psrv_remote = UDP(p2psrv_server, int(p2psrv_port), debug=False)
    p2psrv_remote.request(f"/probe/device/{SERIAL}")
    res = p2psrv_remote.request(f"/info/device/{SERIAL}")
    device_salt = extract_randsalt_from_info(res["data"]["body"]["Info"]) or auth_salt
    p2psrv_remote.close()

    device_remote = UDP(MAIN_SERVER, MAIN_PORT, debug=False)
    laddr = f"127.0.0.1:{device_remote.lport}"
    key = hashlib.md5(f"{USER}:Login to {key_salt}:{PWD}".encode()).hexdigest().upper().encode()
    nonce = get_nonce()
    enc_laddr = get_enc(key, nonce, laddr)
    ipaddr = f"<IpEncrptV2>true</IpEncrptV2><LocalAddr>{enc_laddr}</LocalAddr>"
    auth = get_auth(USER, key, nonce, enc_laddr, randsalt=auth_salt)
    aid = random.randbytes(8)
    device_remote.request(
        f"/device/{SERIAL}/p2p-channel",
        f"<body>{auth}<Identify>{' '.join(f'{b:x}' for b in aid)}</Identify>{ipaddr}<version>5.0.0</version></body>",
        should_read=False,
    )
    res = device_remote.read(return_error=True)
    err = res.get("data", {}).get("body", {}) if res.get("data") else {}
    if isinstance(err, dict):
        return f"{label}: {res['code']} {err.get('Error', res.get('status'))}"
    return f"{label}: {res['code']} {res.get('status')}"


def main() -> None:
    ds = try_mode("fetch", key_salt=RANDSALT, auth_salt=RANDSALT)
    print(ds)
    # re-fetch device salt
    main_remote = UDP(MAIN_SERVER, MAIN_PORT, debug=False)
    main_remote.request("/probe/p2psrv")
    res = main_remote.request(f"/online/p2psrv/{SERIAL}")
    p2psrv_server, p2psrv_port = res["data"]["body"]["US"].split(":")
    p2psrv_remote = UDP(p2psrv_server, int(p2psrv_port), debug=False)
    p2psrv_remote.request(f"/probe/device/{SERIAL}")
    res = p2psrv_remote.request(f"/info/device/{SERIAL}")
    device_salt = extract_randsalt_from_info(res["data"]["body"]["Info"]) or RANDSALT
    print("device_salt", device_salt)
    print(try_mode("global_key+device_auth", key_salt=RANDSALT, auth_salt=device_salt))
    print(try_mode("device_both", key_salt=device_salt, auth_salt=device_salt))
    print(try_mode("device_key+global_auth", key_salt=device_salt, auth_salt=RANDSALT))


if __name__ == "__main__":
    main()
