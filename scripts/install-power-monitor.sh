#!/bin/bash
set -e

# Install Intel RAPL power monitor service
# Run as: sudo bash scripts/install-power-monitor.sh

cat > /usr/local/bin/power-monitor << 'PYEOF'
#!/usr/bin/env python3
import json, os, time
from pathlib import Path

INTERVAL = 5
OUT_DIR = Path("/run/power-monitor")
OUT_FILE = OUT_DIR / "current.json"
POWERCAP = Path("/sys/class/powercap")

DOMAINS = {
    "intel-rapl:0":   "pkg0",
    "intel-rapl:0:0": "core0",
    "intel-rapl:0:1": "dram0",
    "intel-rapl:1":   "pkg1",
    "intel-rapl:1:0": "core1",
    "intel-rapl:1:1": "dram1",
}

def read_uj(domain):
    try: return int((POWERCAP / domain / "energy_uj").read_text())
    except: return None

def read_max_uj(domain):
    try: return int((POWERCAP / domain / "max_energy_range_uj").read_text())
    except: return 2**32

def sample():
    return {label: read_uj(domain) for domain, label in DOMAINS.items()}

def calc_watts(prev, curr, elapsed):
    result = {}
    for domain, label in DOMAINS.items():
        p, c = prev.get(label), curr.get(label)
        if p is None or c is None:
            result[label] = None
            continue
        delta = c - p
        if delta < 0:
            delta += read_max_uj(domain)
        result[label] = round(delta / elapsed / 1e6, 2)
    return result

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(OUT_DIR, 0o755)
    prev = sample()
    prev_time = time.monotonic()
    while True:
        time.sleep(INTERVAL)
        now = time.monotonic()
        curr = sample()
        elapsed = now - prev_time
        watts = calc_watts(prev, curr, elapsed)
        pkg_w  = sum(w for k, w in watts.items() if k.startswith("pkg")  and w is not None)
        dram_w = sum(w for k, w in watts.items() if k.startswith("dram") and w is not None)
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "interval_s": round(elapsed, 1),
            "watts": watts,
            "totals": {
                "package_w": round(pkg_w, 2),
                "dram_w":    round(dram_w, 2),
                "system_w":  round(pkg_w + dram_w, 2),
            },
        }
        tmp = OUT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        os.chmod(tmp, 0o644)
        tmp.rename(OUT_FILE)
        prev = curr
        prev_time = now

if __name__ == "__main__":
    main()
PYEOF

chmod +x /usr/local/bin/power-monitor

cat > /etc/systemd/system/power-monitor.service << 'EOF'
[Unit]
Description=Intel RAPL Power Monitor
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/local/bin/power-monitor
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now power-monitor

echo "Waiting for first reading..."
sleep 7
cat /run/power-monitor/current.json
