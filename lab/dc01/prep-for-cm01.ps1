# Run on DC01 before CM01 joins the domain.
# 1) Offline domain join: create CM01's computer account and a join blob.
#    The blob is copied to CM01 and applied with:
#    djoin /requestODJ /loadfile cm01.djoin /windowspath C:\Windows /localos
# 2) ConfigMgr AD publishing: System Management container + full control for CM01$.

New-Item -ItemType Directory -Path C:\LabStaging -Force | Out-Null
djoin.exe /provision /domain lab.internal /machine CM01 /savefile C:\LabStaging\cm01.djoin

$sys = 'CN=System,DC=lab,DC=internal'
if (-not (Get-ADObject -Filter "Name -eq 'System Management'" -SearchBase $sys -SearchScope OneLevel)) {
    New-ADObject -Name 'System Management' -Type container -Path $sys
}
dsacls.exe "CN=System Management,$sys" /I:T /G 'LAB\CM01$:GA'
