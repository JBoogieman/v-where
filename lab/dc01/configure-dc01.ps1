# DC01 build steps (run as SYSTEM via the QEMU guest agent, or as a local admin).
# Stage 1: network + roles. Stage 2 (promotion) prompts for the DSRM password,
# so run it interactively. Stage 3: DNS + DHCP.

#region Stage 1 - static IP, time zone, roles, rename
$if = Get-NetAdapter -Name 'Ethernet'
Set-NetIPInterface -InterfaceIndex $if.ifIndex -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $if.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
New-NetIPAddress -InterfaceIndex $if.ifIndex -IPAddress 10.10.10.10 -PrefixLength 24 -DefaultGateway 10.10.10.1 | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $if.ifIndex -ServerAddresses 1.1.1.1   # temporary until DNS role is up
Set-TimeZone -Id 'Central Standard Time'
Install-WindowsFeature AD-Domain-Services, DNS, DHCP -IncludeManagementTools
Rename-Computer -NewName DC01 -Force
Restart-Computer -Force
#endregion

#region Stage 2 - promote (interactive: prompts for SafeModeAdministratorPassword)
Install-ADDSForest -DomainName lab.internal -DomainNetbiosName LAB -InstallDns -Force
#endregion

#region Stage 3 - DNS forwarders, reverse zone, DHCP
Set-DnsServerForwarder -IPAddress 1.1.1.1, 9.9.9.9
Add-DnsServerPrimaryZone -NetworkId '10.10.10.0/24' -ReplicationScope Forest
netsh dhcp add securitygroups
Restart-Service DHCPServer
Add-DhcpServerv4Scope -Name 'Lab' -StartRange 10.10.10.100 -EndRange 10.10.10.200 -SubnetMask 255.255.255.0 -LeaseDuration 8.00:00:00 -State Active
Set-DhcpServerv4OptionValue -ScopeId 10.10.10.0 -Router 10.10.10.1 -DnsServer 10.10.10.10 -DnsDomain lab.internal -Force
Add-DhcpServerInDC -DnsName 'DC01.lab.internal' -IPAddress 10.10.10.10
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\ServerManager\Roles\12' -Name ConfigurationState -Value 2
#endregion
