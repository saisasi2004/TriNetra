#!/usr/bin/env python3
"""
TriNetra node provisioning over the serial console.

Writes WiFi credentials and node identity into the ESP32's NVS so they never
appear in the firmware binary. Nothing is echoed back except a masked
confirmation, and the password is never printed.

    python provision.py --port COM9 --ssid MyWiFi --password secret \\
        --target-ip 192.168.1.20 --node-id 1 --room "living-room" \\
        --position 0 0 1.2

Read the current config without changing anything:

    python provision.py --port COM9 --show
"""

from __future__ import annotations

import argparse
import getpass
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is required:  pip install pyserial")


#: Printed by console_task() in node_config.c the moment it starts reading.
READY_MARKER = "TriNetra console ready"

#: Log lines the firmware emits on its own. They are not command responses,
#: so they are filtered out of anything we echo back to the operator.
LOG_PREFIXES = ("I (", "W (", "E (", "D (", "V (")


class NodeConsole:
    def __init__(self, port: str, baud: int = 115200, boot_timeout: float = 15.0):
        # Short read timeout so the response loops below stay responsive; the
        # real time limits are enforced by their own deadlines.
        self.ser = serial.Serial(port, baud, timeout=0.2)
        self._reset_board()
        self.ready = self._wait_for_ready(boot_timeout)

    def _reset_board(self) -> None:
        """Pulse the auto-reset circuit so we always start from a known boot.

        Without this we might attach to a board that booted minutes ago, whose
        ready banner is long gone, and have no way to tell a live TriNetra node
        from a blank one. RTS drives EN and DTR drives GPIO0 on every DevKit
        board; holding DTR high keeps the chip out of download mode so it boots
        the application normally.
        """
        try:
            self.ser.dtr = False   # GPIO0 high -> normal boot, not bootloader
            self.ser.rts = True    # EN low     -> hold in reset
            time.sleep(0.1)
            self.ser.reset_input_buffer()
            self.ser.rts = False   # EN high    -> run
        except (OSError, serial.SerialException):
            # Some USB bridges expose no modem control lines. Fall back to
            # simply waiting out whatever boot is already in progress.
            time.sleep(2.0)
            self.ser.reset_input_buffer()

    def _wait_for_ready(self, timeout: float) -> bool:
        """Block until the firmware's console announces itself."""
        deadline = time.time() + timeout
        seen = ""
        while time.time() < deadline:
            chunk = self.ser.read(self.ser.in_waiting or 1)
            if chunk:
                seen += chunk.decode(errors="replace")
                if READY_MARKER in seen:
                    return True
        return False

    def send(self, cmd: str, quiet: bool = False,
             quiet_gap: float = 0.3, hard_cap: float = 6.0) -> str:
        """Send one command and collect the reply.

        Two independent limits, and BOTH are needed. `quiet_gap` ends the read
        once the node stops talking, which is what makes normal commands fast.
        `hard_cap` is the backstop: the node logs sensing status every 500 ms
        and far more densely during WiFi bring-up, so a gap-only rule can be
        re-armed indefinitely by output that has nothing to do with our
        command. Without the cap this function can never return.
        """
        self.ser.reset_input_buffer()
        self.ser.write((cmd + "\n").encode())
        self.ser.flush()

        start = time.time()
        out = []
        deadline = start + 1.5
        while time.time() < deadline and (time.time() - start) < hard_cap:
            chunk = self.ser.read(self.ser.in_waiting or 1)
            if chunk:
                out.append(chunk.decode(errors="replace"))
                deadline = time.time() + quiet_gap

        text = "".join(out)
        if not quiet:
            for line in text.splitlines():
                line = line.strip()
                if line and not line.startswith(LOG_PREFIXES):
                    print(f"    {line}")
        return text

    def close(self) -> None:
        self.ser.close()


def main() -> int:
    p = argparse.ArgumentParser(description="Provision a TriNetra CSI node")
    p.add_argument("--port", required=True, help="Serial port (COM9, /dev/ttyUSB0)")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--ssid")
    p.add_argument("--password", help="omit to be prompted without echo")
    p.add_argument("--target-ip", help="sensing server IP")
    p.add_argument("--target-port", type=int, default=5005)
    p.add_argument("--node-id", type=int, help="1-254, unique per deployment")
    p.add_argument("--room", help="room label, e.g. 'bedroom'")
    p.add_argument("--position", nargs=3, type=float, metavar=("X", "Y", "Z"),
                   help="node position in metres, for server localisation")
    p.add_argument("--calib", type=float, help="ambient calibration seconds")
    p.add_argument("--decimation", type=int, help="send 1 of every N CSI frames")
    p.add_argument("--no-raw-csi", action="store_true",
                   help="vitals/events only — much lower bandwidth")
    p.add_argument("--mock", action="store_true",
                   help="synthetic CSI for bench testing (marks data as mock)")
    p.add_argument("--show", action="store_true", help="print config and exit")
    p.add_argument("--erase", action="store_true", help="factory reset NVS")
    p.add_argument("--no-reboot", action="store_true")
    args = p.parse_args()

    print(f"[*] Opening {args.port} at {args.baud}...")
    try:
        con = NodeConsole(args.port, args.baud)
    except serial.SerialException as e:
        print(f"[!] {e}")
        if "denied" in str(e).lower() or "busy" in str(e).lower():
            print("[!] Another program holds this port. Close any idf.py monitor")
            print("    (Ctrl+]), Arduino serial monitor, or PuTTY, then retry.")
        return 1

    try:
        if not con.ready:
            print(f"[!] No '{READY_MARKER}' banner within 15 s.")
            print("[!] The board on this port is not running TriNetra firmware,")
            print("    or the console is on the other USB port. Nothing was")
            print("    written. Check that:")
            print("      - the flash step finished with 'Hard resetting via RTS pin'")
            print("      - you are on the port labelled UART, not USB (C6 DevKitC-1)")
            print("    Provisioning now would silently do nothing, so stopping here.")
            return 1
        print("[*] Console ready.")

        if args.show:
            print("[*] Current configuration:")
            con.send("SHOW")
            return 0

        if args.erase:
            print("[*] Erasing stored configuration...")
            con.send("ERASE")
            if not args.no_reboot:
                con.send("REBOOT", quiet=True)
            return 0

        password = args.password
        if args.ssid and password is None:
            password = getpass.getpass("    WiFi password (not echoed): ")

        changed = False

        def setopt(key: str, value, mask: bool = False) -> None:
            nonlocal changed
            if value is None:
                return
            shown = "*" * 8 if mask else value
            print(f"    SET {key} = {shown}")
            con.send(f"SET {key} {value}", quiet=True)
            changed = True

        print("[*] Applying configuration:")
        setopt("ssid", args.ssid)
        setopt("pass", password, mask=True)
        setopt("target", args.target_ip)
        setopt("port", args.target_port if args.target_ip else None)
        setopt("node", args.node_id)
        setopt("room", args.room)
        setopt("calib", args.calib)
        setopt("decim", args.decimation)
        if args.position:
            setopt("pos", " ".join(str(v) for v in args.position))
        if args.no_raw_csi:
            setopt("rawcsi", 0)
        if args.mock:
            setopt("mock", 1)

        if not changed:
            print("[!] Nothing to do. Pass --show to read the current config.")
            return 1

        print("[*] Saving to NVS...")
        con.send("SAVE")

        print("[*] Stored configuration:")
        con.send("SHOW")

        if not args.no_reboot:
            print("[*] Rebooting node...")
            con.send("REBOOT", quiet=True)

        print("[+] Done.")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
