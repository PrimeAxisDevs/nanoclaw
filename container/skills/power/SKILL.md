---
name: power
description: Read live CPU and DRAM power draw from Intel RAPL sensors. Use when the user asks about server power consumption, wattage, energy usage, or power draw.
allowed-tools: Bash(cat /run/power-monitor/current.json)
---

# Server Power Monitor

Read the current power reading:

```bash
cat /run/power-monitor/current.json
```

The JSON contains:
- `totals.system_w` — total CPU package + DRAM draw in watts
- `totals.package_w` — both CPU sockets combined
- `totals.dram_w` — both DRAM controllers combined
- `watts.pkg0/pkg1` — per-socket CPU package power
- `watts.core0/core1` — CPU cores only (subset of package)
- `watts.dram0/dram1` — per-socket DRAM power
- `ts` — timestamp of the reading (UTC)
- `interval_s` — measurement window in seconds

Report the total system draw and break down by CPU vs DRAM. Note that RAPL
measures CPU package + DRAM only — it does not include PSU losses, drives,
NICs, or fans, so actual wall draw will be higher.
