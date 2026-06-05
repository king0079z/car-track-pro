"""
DH-P2P + PTCP Implementation
"""
import argparse
import datetime
import os
import random
import select
import socket
import subprocess
import sys
from urllib.parse import quote

from helpers import (
    MAIN_PORT,
    MAIN_SERVER,
    UDP,
    PTCPPayload,
    extract_randsalt_from_info,
    get_auth,
    get_dec,
    get_enc,
    get_key,
    get_nonce,
    parse_device_local_addr,
    set_device_randsalt,
)


def _phase(msg: str) -> None:
    print(msg, flush=True)


def _read_ptcp_safe(remote):
    try:
        return remote.read_ptcp()
    except (TimeoutError, socket.timeout, OSError):
        return None


def _read_ptcp_with_body(remote, *, label: str, max_tries: int = 50):
    for _ in range(max_tries):
        res = _read_ptcp_safe(remote)
        if res is None or len(res.body) == 0:
            continue
        if res.body[0] == 0x13:
            remote.request_ptcp()
            continue
        return res
    _phase(f"Error: {label} timed out (no PTCP payload).")
    sys.exit(1)


def _ptcp_expect(remote, expected: bytes, *, label: str, max_tries: int = 50) -> None:
    last_body = b""
    for _ in range(max_tries):
        res = _read_ptcp_safe(remote)
        if res is None:
            continue
        if len(res.body) == 0:
            continue
        last_body = res.body
        if res.body[0] == 0x13:
            remote.request_ptcp()
            continue
        if res.body == expected:
            return
    _phase(f"Error: {label} — got {last_body[:12]!r} expected {expected!r}")
    sys.exit(1)


def _recv_device(remote, *, timeout: float = 12.0, required: bool = True):
    try:
        return remote.recv(timeout=timeout)
    except socket.timeout:
        if required:
            _phase(
                "Timeout occurred while waiting for a response from the device (STUN/UDP). "
                "Allow UDP outbound on this PC, or use Same Wi-Fi (LAN IP) in CarTrack."
            )
            sys.exit(1)
        return None


def _stun_local_host(device_laddr: str) -> tuple[str, int]:
    """Resolve LAN IP:port for STUN reply (cloud LocalAddr or env fallback)."""
    fallback = (os.environ.get("P2P_LAN_FALLBACK") or "").strip()
    try:
        return parse_device_local_addr(device_laddr)
    except (ValueError, OSError):
        if fallback and ":" in fallback:
            host, _, port_s = fallback.rpartition(":")
            return host.strip(), int(port_s)
        if fallback:
            return fallback, 554
        raise


def main(serial, dtype=0, username=None, password=None, debug=False, local_port=18554, quiet=True):
    env_salt = (os.environ.get("P2P_DEVICE_RANDSALT") or "").strip()
    set_device_randsalt(env_salt or None)
    udp_kw = {"debug": debug, "quiet": quiet and not debug}
    socketserver = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    socketserver.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    socketserver.bind(("127.0.0.1", int(local_port)))
    socketserver.listen(5)
    print(f"Listening on 127.0.0.1:{int(local_port)}", flush=True)

    if debug:
        subprocess.Popen(
            [
                "ffplay",
                "-rtsp_transport",
                "tcp",
                "-i",
                f"rtsp://{username}:{quote(password)}@127.0.0.1/cam/realmonitor?channel=6&subtype=0",
            ]
        )

    main_remote = UDP(MAIN_SERVER, MAIN_PORT, **udp_kw)
    res = main_remote.request("/probe/p2psrv")

    res = main_remote.request(f"/online/p2psrv/{serial}")

    p2psrv_server, p2psrv_port = res["data"]["body"]["US"].split(":")
    p2psrv_port = int(p2psrv_port)

    p2psrv_remote = UDP(p2psrv_server, p2psrv_port, **udp_kw)
    res = p2psrv_remote.request(f"/probe/device/{serial}")
    res = p2psrv_remote.request(f"/info/device/{serial}")
    device_salt = None
    try:
        info_blob = res["data"]["body"]["Info"]
        device_salt = extract_randsalt_from_info(info_blob)
        if device_salt:
            set_device_randsalt(device_salt)
            print(f"Using device RandSalt ({len(device_salt)} chars)", flush=True)
    except (KeyError, TypeError):
        set_device_randsalt(None)
    p2psrv_remote.close()

    res = main_remote.request("/online/relay")
    relay_server, relay_port = res["data"]["body"]["Address"].split(":")
    relay_port = int(relay_port)

    device_remote = UDP(MAIN_SERVER, MAIN_PORT, **udp_kw)

    laddr = f"127.0.0.1:{device_remote.lport}"
    ipaddr = f"<IpEncrpt>true</IpEncrpt><LocalAddr>{laddr}</LocalAddr>"
    auth = ""
    aid = random.randbytes(8)

    if dtype > 0:
        key = get_key(username, password, key_salt=device_salt)
        nonce = get_nonce()

        laddr = get_enc(key, nonce, laddr)
        ipaddr = f"<IpEncrptV2>true</IpEncrptV2><LocalAddr>{laddr}</LocalAddr>"
        auth = "" if dtype == 0 else get_auth(username, key, nonce, laddr, randsalt=device_salt)

    res = device_remote.request(
        f"/device/{serial}/p2p-channel",
        f"<body>{auth}<Identify>{' '.join(f'{b:x}' for b in aid)}</Identify>{ipaddr}<version>5.0.0</version></body>",
        should_read=False,
    )

    main_remote.rhost = relay_server
    main_remote.rport = relay_port
    res = main_remote.request("/relay/agent")
    token = res["data"]["body"]["Token"]
    agent_server, agent_port = res["data"]["body"]["Agent"].split(":")
    agent_port = int(agent_port)

    main_remote.rhost = agent_server
    main_remote.rport = agent_port
    res = main_remote.request(
        f"/relay/start/{token}",
        "<body><Client>:0</Client></body>",
    )

    res = device_remote.read(return_error=True)
    if res["code"] < 200:
        res = device_remote.read(return_error=True)

    if res["code"] >= 400:
        print("Error:", res["status"])

        if dtype == 0 and res["code"] == 403:
            print("Device requires authentication when creating P2P channel.")
            print("Try again with:")
            print(
                f"main.py --type 1 --username <username> --password <password> {serial}"
            )

        sys.exit(1)

    device_laddr = res["data"]["body"]["LocalAddr"]
    if dtype > 0:
        nonce = res["data"]["body"]["Nonce"]
        device_laddr = get_dec(key, nonce, device_laddr)

    device_server, device_port = res["data"]["body"]["PubAddr"].split(":")
    device_port = int(device_port)
    device_remote.rhost = device_server
    device_remote.rport = device_port

    main_remote.rhost = MAIN_SERVER
    main_remote.rport = MAIN_PORT

    if dtype > 0:
        auth = get_auth(username, key, nonce, randsalt=device_salt)

    res = main_remote.request(
        f"/device/{serial}/relay-channel",
        f"<body>{auth}<agentAddr>{agent_server}:{agent_port}</agentAddr></body>",
        should_read=False,
    )

    main_remote.rhost = agent_server
    main_remote.rport = agent_port
    # TODO check timeout
    _phase("P2P: relay agent connected, negotiating PTCP…")
    res = main_remote.read()

    main_remote.request_ptcp(b"\x00\x03\x01\x00")
    res = main_remote.read_ptcp()

    main_remote.request_ptcp(b"\x17\x00\x00\x00" + b"\x00\x00\x00\x00\x00\x00\x00\x00")
    res = _read_ptcp_with_body(main_remote, label="PTCP sign from relay agent")
    sign = res.body[12:]

    main_remote.request_ptcp()

    device_remote.rhost = device_server
    device_remote.rport = device_port

    aid = bytes(0xFF - b for b in aid)
    cookie = random.randbytes(4)
    trasn_id = random.randbytes(12)
    eaddr = device_port.to_bytes(2) + socket.inet_aton(device_server)
    eaddr = bytes(0xFF - b for b in eaddr)

    data = (
        b"\xff\xfe\xff\xe7"
        + cookie
        + trasn_id
        + b"\x7f\xd5\xff\xf7"
        + aid
        + b"\xff\xfb\xff\xf7\xff\xfe"
        + eaddr
    )
    print(f":{device_remote.lport} >>> {device_remote.rhost}:{device_remote.rport}")
    print("".join(f"\\x{b:02X}" for b in data))
    device_remote.send(data)

    _phase("P2P: STUN hole-punch to camera (UDP)…")
    data = _recv_device(device_remote, timeout=12)

    print("Data <<<")
    print("".join(f"\\x{b:02X}" for b in data))

    rtrans_id = data[8:20]
    ip, port = _stun_local_host(device_laddr)
    eaddr = port.to_bytes(2) + socket.inet_aton(ip)

    data = (
        b"\xfe\xfe\xff\xe7"
        + cookie
        + rtrans_id
        + b"\x7f\xd6\xff\xf7"
        + aid
        + b"\xff\xfb\xff\xf7\xff\xfe"
        + eaddr
    )
    print("Request >>>")
    print("".join(f"\\x{b:02X}" for b in data))
    device_remote.send(data)

    if dtype > 0:
        data = _recv_device(device_remote, timeout=15, required=False)
        if data and debug:
            print("Data <<<")
            print("".join(f"\\x{b:02X}" for b in data))

        data = (
            b"\xfe\xfe\xff\xf3"
            + cookie
            + rtrans_id
            + b"\x7f\xd6\xff\xf7"
            + aid
            + b"\xff\xfb\xff\xf7\xff\xfe"
            + b"\xa8\x13\x3f\x57\xfe\x37"
        )

        for _ in range(8):
            if debug:
                print("Request >>>")
                print("".join(f"\\x{b:02X}" for b in data))
            device_remote.send(data)

    stun_replies = 0
    for i in range(12):
        data = _recv_device(device_remote, timeout=5, required=False)
        if data is None:
            if stun_replies >= 1:
                break
            continue
        stun_replies += 1
        if debug:
            print("Data <<<")
            print("".join(f"\\x{b:02X}" for b in data))
        if stun_replies == 1:
            _phase("P2P: device responded to STUN, finishing handshake…")

    if stun_replies < 1:
        _phase(
            "Timeout occurred while waiting for a response from the device (STUN/UDP). "
            "Allow UDP outbound on this PC, or use Same Wi-Fi (LAN IP) in CarTrack."
        )
        sys.exit(1)

    _phase("P2P: PTCP handshake with camera…")
    device_remote.request_ptcp(b"\x00\x03\x01\x00")
    _ptcp_expect(device_remote, b"\x00\x03\x01\x00", label="PTCP SYN-ACK")

    device_remote.request_ptcp(
        b"\x19\x00\x00\x00" + b"\x00\x00\x00\x00" + b"\x00\x00\x00\x00" + sign
    )
    res = _read_ptcp_with_body(device_remote, label="PTCP device sign")
    if res.body[0] != 0x1A:
        _phase(f"Error: PTCP sign response invalid ({res.body[:4]!r}).")
        sys.exit(1)

    device_remote.request_ptcp(
        b"\x1b\x00\x00\x00" + b"\x00\x00\x00\x00" + b"\x00\x00\x00\x00"
    )
    for _ in range(20):
        res = device_remote.read_ptcp()
        if len(res.body) == 0:
            break
        if res.body[0] == 0x13:
            device_remote.request_ptcp()
            continue
        _phase(f"Error: expected empty PTCP ACK, got {res.body[:8]!r}.")
        sys.exit(1)

    _phase("Ready to connect")
    print(
        f"Test with: rtsp://127.0.0.1:{int(local_port)}/cam/realmonitor?channel=1&subtype=0",
        flush=True,
    )
    while True:
        ready, _, _ = select.select([socketserver], [], [], 0.1)

        if not ready:
            ptcp_ready, _, _ = select.select([device_remote], [], [], 0)

            if not ptcp_ready:
                continue

            # only simplex, duplex is not supported
            res = device_remote.read_ptcp()
            if len(res.body) == 0:
                continue

            assert res.body[0] == 0x13
            device_remote.request_ptcp()

            continue

        socketclient, address = socketserver.accept()
        print(f"Connection from {address}")

        realm_id = random.randint(0x00000000, 0xFFFFFFFF)
        device_remote.request_ptcp(
            b"\x11\x00\x00\x00"
            + realm_id.to_bytes(4, "big")
            + b"\x00\x00\x00\x00"
            # port 554
            + b"\x00\x00\x02\x2A"
            + b"\x7f\x00\x00\x01",
        )
        res = device_remote.read_ptcp()
        if len(res.body) == 0:
            res = device_remote.read_ptcp()
        assert res.body[0] == 0x12

        try:
            while True:
                ptcp_ready, _, _ = select.select([device_remote], [], [], 0.1)

                # if ptcp_ready:
                while ptcp_ready:
                    res = device_remote.read_ptcp()

                    if len(res.body) == 0:
                        continue

                    device_remote.request_ptcp()

                    if res.body[0] != 0x10:
                        continue

                    body = PTCPPayload.parse(res.body)

                    if debug:
                        print()
                        print(body)
                        print(f"[{datetime.datetime.now().isoformat()}]")
                        print("Data <<<")
                        print(body.payload)
                        print()

                    socketclient.send(body.payload)

                    ptcp_ready, _, _ = select.select([device_remote], [], [], 0.1)

                client_ready, _, _ = select.select([socketclient], [], [], 0)

                if not client_ready:
                    continue

                data = socketclient.recv(4096)

                if not data:
                    print("Connection closed?")
                    break

                if debug:
                    print()
                    print(f"[{datetime.datetime.now().isoformat()}]")
                    print("Data >>>")
                    print(data)
                    print()

                device_remote.request_ptcp(bytes(PTCPPayload(realm_id, data)))

        # handle connection reset by peer
        except ConnectionResetError:
            print("Connection reset by peer")
        except BrokenPipeError:
            print("Broken pipe")
        finally:
            print("Cleaning up connection")
            device_remote.request_ptcp(
                b"\x12\x00\x00\x00"
                + realm_id.to_bytes(4, "big")
                + b"\x00\x00\x00\x00"
                + b"DISC"
            )

            res = device_remote.read_ptcp()

            while len(res.body) == 0 or res.body[0] == 0x10:
                if len(res.body) > 0:
                    device_remote.request_ptcp()

                res = device_remote.read_ptcp()

            assert res.body[0] == 0x12
            device_remote.request_ptcp()

            socketclient.close()
            print("Connection closed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("serial", help="Serial number of the camera")
    parser.add_argument("-d", "--debug", action="store_true", help="Enable debug mode")
    parser.add_argument("-t", "--type", type=int, help="Type of the camera", default=0)
    parser.add_argument("-u", "--username", help="Username of the camera")
    parser.add_argument("-p", "--password", help="Password of the camera")
    parser.add_argument(
        "--local-port",
        type=int,
        default=18554,
        help="Local TCP port for RTSP tunnel (default 18554)",
    )
    parser.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        default=True,
        help="Suppress P2P protocol debug output (default: on)",
    )
    args = parser.parse_args()

    if args.username is None or args.password is None:
        if args.type > 0:
            parser.error("Username and password are required for type > 0")
        elif args.debug:
            parser.error("Username and password are required in debug mode")

    if args.serial:
        main(
            args.serial,
            args.type,
            args.username,
            args.password,
            args.debug,
            local_port=args.local_port,
            quiet=args.quiet,
        )
