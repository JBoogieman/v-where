# Building the v_Where lab

v_Where needs a real Configuration Manager site database to read view and column definitions from. This is how the lab behind it was built: one Proxmox host, an isolated lab network, a domain controller, and a ConfigMgr primary site.

## Hardware

A retired gaming PC: Intel i7-10700K (8 cores / 16 threads), 32 GB RAM, 1 TB NVMe, Proxmox VE 9.

## Network design

```
Home LAN ──── vmbr0 (Proxmox management, dev box)
                │
             Proxmox host  (NAT / IP forwarding)
                │
Lab LAN  ──── vmbr1  10.10.10.0/24, gateway 10.10.10.1
                ├── DC01      10.10.10.10   AD DS, DNS, DHCP
                ├── CM01      10.10.10.11   SQL Server + ConfigMgr
                ├── vwhere-dev 10.10.10.20  (second NIC)
                └── clients   DHCP 10.10.10.100-200
```

Why a separate lab network:

- The DC runs DHCP. On the home network it would fight the home router.
- Anything broken or deliberately attacked in the lab stays away from home devices.
- It mirrors an enterprise layout: the lab owns its DNS, DHCP and (later) PXE.

`vmbr1` is a bridge with no physical port. The Proxmox host is its gateway and masquerades lab traffic out through the home network. See [`lab/proxmox/vmbr1-nat.interfaces`](../lab/proxmox/vmbr1-nat.interfaces).

## Machines

| VM | OS | vCPU | RAM | Disk |
|---|---|---|---|---|
| DC01 | Windows Server 2025 Standard (eval, Desktop Experience) | 2 | 4 GB | 60 GB |
| CM01 | Windows Server 2025 Standard (eval, Desktop Experience) | 4 | 12 GB | 150 GB |
| vwhere-dev | Debian 13 LXC container | 2 | 2 GB | 16 GB |

All Windows VMs: q35, UEFI + TPM 2.0, VirtIO SCSI (single, discard, IO thread), VirtIO NIC, QEMU guest agent enabled.

## Build order

1. **Proxmox**: no-subscription repo, updates, `vmbr1` lab bridge with NAT.
2. **DC01**: install Windows, VirtIO guest tools, then [`lab/dc01/configure-dc01.ps1`](../lab/dc01/configure-dc01.ps1) (static IP, roles), promote to a new forest (`lab.internal`), then DNS forwarders and the DHCP scope.
3. **CM01 prep on DC01**: offline domain join blob, `System Management` container, permissions. See [`lab/dc01/prep-for-cm01.ps1`](../lab/dc01/prep-for-cm01.ps1).
4. **CM01**: install Windows, VirtIO guest tools, then [`lab/cm01/prep-cm01.ps1`](../lab/cm01/prep-cm01.ps1) (IP, offline domain join, IIS/BITS/RDC, ADK + WinPE, ODBC, SQL Server 2022 Developer).
5. **ConfigMgr 2509**: unattended install with [`lab/cm01/ConfigMgrSetup.ini`](../lab/cm01/ConfigMgrSetup.ini).

Post-install configuration steps after Windows Setup were run remotely through the **QEMU guest agent** (Proxmox API `agent/exec`), so no RDP or console clicking was needed. Commands run as `NT AUTHORITY\SYSTEM`.

## Gotchas hit along the way

These cost real time. Writing them down so they don't again.

| Symptom | Cause | Fix |
|---|---|---|
| Windows Setup shows no disks | Windows has no VirtIO SCSI driver | *Load driver* → VirtIO ISO → `vioscsi\2k25\amd64` |
| Proxmox UI unreachable after install | Installer IP was on a different subnet than the home network | Fix `address`/`gateway` in `/etc/network/interfaces` and the IP in `/etc/hosts`, then `ifreload -a` |
| `/etc/network/interfaces` became empty | `sed -i` + a stray `-n` (from a mistyped combined command) writes nothing back | Keep a backup before editing network config; type one command per line |
| Domain join without passwords | Needed to automate the join | `djoin /provision` on the DC, `djoin /requestODJ /localos` on the member |
| ConfigMgr `setupdl.exe /NOUI` hangs at 0 bytes | It waits on an invisible prompt when **ODBC Driver 18 for SQL Server** is missing | Install ODBC 18 first, then rerun `setupdl` |
| Prereq error: SQL service account not allowed | SQL Server's default `NT Service\MSSQLSERVER` virtual account is rejected | Run the SQL service as LocalSystem (or a domain account) via the SQL WMI provider |
| Prereq error: .NET Framework 3.5 required | Not installed on Server 2025 by default; Windows Update download stalled | `dism /online /enable-feature /featurename:NetFx3 /all /source:<ServerISO>\sources\sxs /limitaccess` |
| Setup fails: "could not install SQL RMO" (`msoledbsql.msi` 1603) | OLE DB Driver 19 needs the **Visual C++ 2015-2022 redistributable** (14.34+) | Install `vc_redist.x64.exe` (and x86), then rerun setup |
| ConfigMgr eval `.exe` won't open as a zip | It's a **7-Zip SFX**, not a zip | `ConfigMgr_2509.exe -oC:\CMSource -y` |
| Setup ran as SYSTEM | Only the account that installs ConfigMgr gets Full Administrator | Add a real admin account afterwards (see below) |

## After install

- Grant `LAB\Domain Admins` the Full Administrator role in ConfigMgr.
- Confirm the site database (`CM_LAB`) contains the `v_` views v_Where reads.
