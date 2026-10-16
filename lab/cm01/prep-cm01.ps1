# CM01 prep for a ConfigMgr primary site (run as SYSTEM via the QEMU guest agent).
# Order matters: see docs/lab-build.md "Gotchas" for why each step exists.
$ErrorActionPreference = 'Stop'
$stage = 'C:\LabStaging'; New-Item -ItemType Directory -Path $stage -Force | Out-Null

#region Network + offline domain join (cm01.djoin copied from DC01 first)
$if = Get-NetAdapter -Name 'Ethernet'
Set-NetIPInterface -InterfaceIndex $if.ifIndex -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $if.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
New-NetIPAddress -InterfaceIndex $if.ifIndex -IPAddress 10.10.10.11 -PrefixLength 24 -DefaultGateway 10.10.10.1 | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $if.ifIndex -ServerAddresses 10.10.10.10
Set-TimeZone -Id 'Central Standard Time'
Rename-Computer -NewName CM01 -Force
djoin.exe /requestODJ /loadfile C:\Windows\Temp\cm01.djoin /windowspath C:\Windows /localos
Restart-Computer -Force
#endregion

#region Windows features for MP/DP + firewall + Defender exclusions
Install-WindowsFeature -IncludeManagementTools -Name `
  Web-Server, Web-WebServer, Web-Common-Http, Web-Default-Doc, Web-Dir-Browsing, Web-Http-Errors, `
  Web-Static-Content, Web-Http-Redirect, Web-Health, Web-Http-Logging, Web-Performance, Web-Stat-Compression, `
  Web-Security, Web-Filtering, Web-Windows-Auth, Web-App-Dev, Web-Net-Ext45, Web-Asp-Net45, Web-ISAPI-Ext, `
  Web-ISAPI-Filter, Web-Mgmt-Tools, Web-Mgmt-Console, Web-Mgmt-Compat, Web-Metabase, Web-WMI, BITS, BITS-IIS-Ext, RDC
Set-Service BITS -StartupType Automatic; Start-Service BITS
New-NetFirewallRule -DisplayName 'SQL Server 1433' -Direction Inbound -Protocol TCP -LocalPort 1433 -Action Allow -Profile Domain
New-NetFirewallRule -DisplayName 'SQL Service Broker 4022' -Direction Inbound -Protocol TCP -LocalPort 4022 -Action Allow -Profile Domain
Add-MpPreference -ExclusionPath $stage, 'C:\Program Files\Microsoft Configuration Manager', 'C:\Program Files\Microsoft SQL Server'
#endregion

#region .NET Framework 3.5 from the Server ISO (Windows Update was too slow)
# D: = Windows Server 2025 ISO
dism.exe /online /enable-feature /featurename:NetFx3 /all /source:D:\sources\sxs /limitaccess /norestart
#endregion

#region Downloads
$dl = @{
  'adksetup.exe'       = 'https://go.microsoft.com/fwlink/?linkid=2289980'   # Windows ADK 10.1.26100
  'adkwinpesetup.exe'  = 'https://go.microsoft.com/fwlink/?linkid=2289981'   # WinPE add-on
  'ConfigMgr_2509.exe' = 'https://go.microsoft.com/fwlink/?linkid=2350307'   # ConfigMgr 2509 eval
  'msodbcsql.msi'      = 'https://go.microsoft.com/fwlink/?linkid=2378279'   # ODBC Driver 18
  'vc_redist.x64.exe'  = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
  'vc_redist.x86.exe'  = 'https://aka.ms/vs/17/release/vc_redist.x86.exe'
}
foreach ($k in $dl.Keys) { curl.exe -sSL -o (Join-Path $stage $k) $dl[$k] }
#endregion

#region Runtimes and drivers ConfigMgr setup needs
Start-Process "$stage\vc_redist.x64.exe" -ArgumentList '/install','/quiet','/norestart' -Wait
Start-Process "$stage\vc_redist.x86.exe" -ArgumentList '/install','/quiet','/norestart' -Wait
Start-Process msiexec.exe -ArgumentList '/i',"$stage\msodbcsql.msi",'/qn','/norestart','IACCEPTMSODBCSQLLICENSETERMS=YES' -Wait
#endregion

#region Windows ADK + WinPE
Start-Process "$stage\adksetup.exe" -ArgumentList '/quiet','/norestart','/ceip','off','/features','OptionId.DeploymentTools','OptionId.UserStateMigrationTool' -Wait
Start-Process "$stage\adkwinpesetup.exe" -ArgumentList '/quiet','/norestart','/ceip','off','/features','OptionId.WindowsPreinstallationEnvironment' -Wait
#endregion

#region SQL Server 2022 Developer (E: = SQL ISO)
$sqlArgs = '/Q /ACTION=Install /FEATURES=SQLENGINE /INSTANCENAME=MSSQLSERVER /SQLCOLLATION=SQL_Latin1_General_CP1_CI_AS ' +
           '/SQLSVCACCOUNT="NT Service\MSSQLSERVER" /AGTSVCACCOUNT="NT Service\SQLSERVERAGENT" /AGTSVCSTARTUPTYPE=Automatic ' +
           '/SQLSYSADMINACCOUNTS="NT AUTHORITY\SYSTEM" "BUILTIN\Administrators" "LAB\Domain Admins" ' +
           '/TCPENABLED=1 /SQLMAXMEMORY=7168 /SQLMINMEMORY=1024 /UPDATEENABLED=False /IACCEPTSQLSERVERLICENSETERMS /SUPPRESSPRIVACYSTATEMENTNOTICE'
Start-Process 'E:\setup.exe' -ArgumentList $sqlArgs -Wait
# ConfigMgr rejects the NT Service virtual account: switch the engine to LocalSystem
$svc = Get-CimInstance -Namespace root\Microsoft\SqlServer\ComputerManagement16 -ClassName SqlService -Filter "ServiceName='MSSQLSERVER'"
Invoke-CimMethod -InputObject $svc -MethodName SetServiceAccount -Arguments @{ ServiceStartName = 'LocalSystem'; ServiceStartPassword = '' }
Restart-Service MSSQLSERVER -Force
#endregion

#region ConfigMgr media + prerequisites
Start-Process "$stage\ConfigMgr_2509.exe" -ArgumentList '-oC:\CMSource','-y' -Wait          # 7-Zip SFX
New-Item -ItemType Directory -Path C:\CMPrereqs -Force | Out-Null
Start-Process 'C:\CMSource\SMSSETUP\BIN\X64\setupdl.exe' -ArgumentList '/NOUI','C:\CMPrereqs' -Wait
# Prerequisite check only (log: C:\ConfigMgrPrereq.log)
Start-Process 'C:\CMSource\SMSSETUP\BIN\X64\prereqchk.exe' -ArgumentList '/NOUI','/PRI','/SQL','CM01.lab.internal','/SDK','CM01.lab.internal','/MP','CM01.lab.internal','/DP','CM01.lab.internal' -Wait
#endregion

# Reboot if anything is pending, then:
#   C:\CMSource\SMSSETUP\BIN\X64\setup.exe /script C:\LabStaging\ConfigMgrSetup.ini /NoUserInput
# Log: C:\ConfigMgrSetup.log
