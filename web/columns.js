/* v_Where column descriptions
 *
 * One-line, plain-English descriptions for the columns people report on most.
 * ConfigMgr's views carry no descriptions of their own, so these are written by hand and cover a small set.
 *
 *   describe(view, column)  -> description, or '' when there isn't one
 *
 * Lookup order: "view.column" first, then the same column in the matching current view
 * (fn_rbac_GS_X and v_HS_X use v_GS_X's), then the column name on its own.
 *
 * Plain script, no dependencies. In the page it sets window.VWhereColumns; in Node, require() returns it.
 */
(function (root) {
  'use strict';

  // Same meaning in any view
  const ANY = {
    ResourceID: 'ConfigMgr\'s ID for the device. Views are lined up on it.',
    MachineID: 'Device ID (the ResourceID in v_R_System).',
    MachineResourceID: 'Device ID (the ResourceID in v_R_System).',
    UserResourceID: 'User ID (the ResourceID in v_R_User).',
    CI_ID: 'ID of an update, application or configuration item.',
    CollectionID: 'Collection ID, like SMS00001 (All Systems).',
    GroupID: 'Numbers the rows a device has in this view (one per drive, adapter...). Not a security group.',
    RevisionID: 'Goes up each time inventory reports a change to this row.',
    AgentID: 'Which inventory agent reported the row.',
    TimeStamp: 'When inventory last reported this row.',
    AdvertisementID: 'ID of a package or task sequence deployment.',
  };

  const BY_VIEW = {
    // Devices (discovery)
    'v_R_System.Name0': 'Computer name.',
    'v_R_System.Netbios_Name0': 'Computer name.',
    'v_R_System.Resource_Domain_OR_Workgr0': 'Domain or workgroup.',
    'v_R_System.Full_Domain_Name0': 'Full DNS domain name.',
    'v_R_System.Operating_System_Name_and0': 'Windows name and version as discovery saw it, like "Microsoft Windows NT Workstation 10.0".',
    'v_R_System.Build01': 'Windows version and build, like 10.0.22631.',
    'v_R_System.Client0': '1 = the ConfigMgr client is installed.',
    'v_R_System.Client_Version0': 'ConfigMgr client version.',
    'v_R_System.Active0': '1 = the client is active (checking in).',
    'v_R_System.Obsolete0': '1 = an old record, replaced by a newer one for the same device.',
    'v_R_System.Decommissioned0': '1 = the record was marked decommissioned.',
    'v_R_System.Unknown0': '1 = one of the "Unknown Computer" placeholder records used for OS deployment.',
    'v_R_System.Last_Logon_Timestamp0': 'Last logon as Active Directory records it. AD updates it lazily, so it can lag by up to two weeks.',
    'v_R_System.User_Name0': 'Last user to log on, as discovery saw it.',
    'v_R_System.User_Domain0': 'Domain of the last user to log on.',
    'v_R_System.AD_Site_Name0': 'Active Directory site.',
    'v_R_System.Distinguished_Name0': 'Full Active Directory path of the computer object, OU included.',
    'v_R_System.Creation_Date0': 'When ConfigMgr created this record.',
    'v_R_System.SMS_Unique_Identifier0': 'The ConfigMgr client\'s unique ID (a GUID).',
    'v_R_System.Is_Virtual_Machine0': '1 = virtual machine.',
    'v_R_System.SID0': 'The computer account\'s security ID in Active Directory.',

    // Users (discovery)
    'v_R_User.ResourceID': 'ConfigMgr\'s ID for the user. Primary users links it to devices.',
    'v_R_User.Unique_User_Name0': 'DOMAIN\\username.',
    'v_R_User.User_Name0': 'Username (the sign-in name without the domain).',
    'v_R_User.Full_User_Name0': 'Display name from Active Directory.',
    'v_R_User.Name0': 'DOMAIN\\username with the display name, as the console shows it.',
    'v_R_User.Mail0': 'Email address from Active Directory.',
    'v_R_User.User_Principal_Name0': 'UPN, like name@example.com.',
    'v_R_User.Windows_NT_Domain0': 'Domain.',
    'v_R_User.Distinguished_Name0': 'Full Active Directory path of the user, OU included.',
    'v_RA_System_SystemOUName.System_OU_Name0': 'One row per OU level the computer sits in, from the domain down.',
    'v_RA_System_IPAddresses.IP_Addresses0': 'One row per IP address the device reported.',
    'v_RA_System_MACAddresses.MAC_Addresses0': 'One row per MAC address the device reported.',
    'v_UsersPrimaryMachines.MachineID': 'Device ID.',
    'v_UsersPrimaryMachines.UserResourceID': 'User ID. A device can have more than one primary user.',

    // Windows
    'v_GS_OPERATING_SYSTEM.Caption0': 'Windows edition, like "Microsoft Windows 11 Enterprise".',
    'v_GS_OPERATING_SYSTEM.Version0': 'Windows version number, like 10.0.22631.',
    'v_GS_OPERATING_SYSTEM.BuildNumber0': 'Windows build number, like 22631.',
    'v_GS_OPERATING_SYSTEM.LastBootUpTime0': 'When Windows last started, as of the last inventory.',
    'v_GS_OPERATING_SYSTEM.InstallDate0': 'When Windows was installed. In-place upgrades reset it.',
    'v_GS_OPERATING_SYSTEM.OSArchitecture0': '64-bit or 32-bit.',
    'v_GS_OPERATING_SYSTEM.ProductType0': '1 = workstation, 2 = domain controller, 3 = server.',
    'v_GS_OPERATING_SYSTEM.OperatingSystemSKU0': 'Edition as a number: 4 = Enterprise, 48 = Pro, 121 = Education...',
    'v_GS_OPERATING_SYSTEM.OSLanguage0': 'Language as a number: 1033 = English (United States).',
    'v_GS_OPERATING_SYSTEM.TotalVisibleMemorySize0': 'Memory Windows can use, in KB.',
    'v_GS_OPERATING_SYSTEM.FreePhysicalMemory0': 'Free memory when inventory ran, in KB.',
    'v_GS_OPERATING_SYSTEM.CSDVersion0': 'Service pack. Blank on Windows 10 and 11.',
    'v_GS_OPERATING_SYSTEM.SerialNumber0': 'Windows product ID, not the hardware serial number (that\'s in v_GS_PC_BIOS).',
    'v_GS_OPERATING_SYSTEM.Name0': 'Windows edition plus install paths, separated by |. Caption0 is cleaner.',

    // Hardware
    'v_GS_COMPUTER_SYSTEM.Manufacturer0': 'Device maker, like Dell Inc., HP or LENOVO.',
    'v_GS_COMPUTER_SYSTEM.Model0': 'Model. Lenovo puts a type code here; the model name is in v_GS_COMPUTER_SYSTEM_PRODUCT.Version0.',
    'v_GS_COMPUTER_SYSTEM.Name0': 'Computer name.',
    'v_GS_COMPUTER_SYSTEM.UserName0': 'User signed in at the console when inventory ran. Blank if nobody was.',
    'v_GS_COMPUTER_SYSTEM.Domain0': 'Domain (or workgroup) the device is in.',
    'v_GS_COMPUTER_SYSTEM.DomainRole0': '0-1 = workstation, 2-3 = server, 4-5 = domain controller.',
    'v_GS_COMPUTER_SYSTEM.SystemType0': 'Platform, like "x64-based PC".',
    'v_GS_COMPUTER_SYSTEM.NumberOfProcessors0': 'Number of CPU sockets (not cores).',
    'v_GS_COMPUTER_SYSTEM.TotalPhysicalMemory0': 'Memory as this class reports it. For reports, v_GS_X86_PC_MEMORY.TotalPhysicalMemory0 is the usual source.',
    'v_GS_COMPUTER_SYSTEM_PRODUCT.Version0': 'Model name on Lenovo, like "ThinkPad T14 Gen 3". Other makers often repeat the model or leave a version here.',
    'v_GS_COMPUTER_SYSTEM_PRODUCT.IdentifyingNumber0': 'Serial number.',
    'v_GS_COMPUTER_SYSTEM_PRODUCT.Name0': 'Model.',
    'v_GS_COMPUTER_SYSTEM_PRODUCT.Vendor0': 'Device maker.',
    'v_GS_COMPUTER_SYSTEM_PRODUCT.UUID0': 'The device\'s SMBIOS UUID.',
    'v_GS_X86_PC_MEMORY.TotalPhysicalMemory0': 'Installed memory, in KB. Readable values shows it in GB.',
    'v_GS_X86_PC_MEMORY.TotalVirtualMemory0': 'Memory plus page file, in KB.',
    'v_GS_X86_PC_MEMORY.AvailableVirtualMemory0': 'Free memory plus free page file when inventory ran, in KB.',
    'v_GS_PC_BIOS.SerialNumber0': 'Serial number (the service tag on Dell).',
    'v_GS_PC_BIOS.SMBIOSBIOSVersion0': 'BIOS version as the maker shows it.',
    'v_GS_PC_BIOS.ReleaseDate0': 'BIOS release date.',
    'v_GS_PC_BIOS.Manufacturer0': 'BIOS maker. Usually the device maker, sometimes the BIOS vendor.',
    'v_GS_SYSTEM_ENCLOSURE.ChassisTypes0': 'Form factor as a number: 3 = desktop, 10 = notebook, 31 = convertible... Readable values shows the name.',
    'v_GS_SYSTEM_ENCLOSURE.SerialNumber0': 'Serial number from the chassis. Usually matches v_GS_PC_BIOS.SerialNumber0.',
    'v_GS_SYSTEM_ENCLOSURE.SMBIOSAssetTag0': 'Asset tag stored in the firmware, if someone set one.',
    'v_GS_PROCESSOR.Name0': 'CPU model, like "Intel(R) Core(TM) i7-1365U".',
    'v_GS_PROCESSOR.NumberOfCores0': 'Cores in this CPU.',
    'v_GS_PROCESSOR.NumberOfLogicalProcessors0': 'Threads in this CPU.',
    'v_GS_PROCESSOR.MaxClockSpeed0': 'Top rated speed, in MHz.',
    'v_GS_PROCESSOR.DeviceID0': 'CPU socket, like CPU0. One row per socket.',
    'v_GS_FIRMWARE.UEFI0': '1 = UEFI, 0 = legacy BIOS.',
    'v_GS_FIRMWARE.SecureBoot0': '1 = Secure Boot is on.',
    'v_GS_TPM.SpecVersion0': 'TPM version, starting with 1.2 or 2.0.',
    'v_GS_TPM.IsActivated_InitialValue0': '1 = TPM activated.',
    'v_GS_TPM.IsEnabled_InitialValue0': '1 = TPM enabled.',
    'v_GS_TPM.IsOwned_InitialValue0': '1 = TPM has an owner (Windows has taken it over).',

    // Disks and BitLocker
    'v_GS_LOGICAL_DISK.DeviceID0': 'Drive letter, like C:. One row per drive.',
    'v_GS_LOGICAL_DISK.Size0': 'Drive size, usually in MB. Check one drive you know before relying on the unit.',
    'v_GS_LOGICAL_DISK.FreeSpace0': 'Free space, usually in MB. Check one drive you know before relying on the unit.',
    'v_GS_LOGICAL_DISK.DriveType0': '3 = local disk, 2 = removable, 4 = network drive, 5 = CD/DVD.',
    'v_GS_LOGICAL_DISK.VolumeName0': 'Drive label.',
    'v_GS_LOGICAL_DISK.FileSystem0': 'NTFS, FAT32, ReFS...',
    'v_GS_DISK.Model0': 'Disk model.',
    'v_GS_DISK.Index0': 'Disk number. 0 is usually the system disk.',
    'v_GS_ENCRYPTABLE_VOLUME.DriveLetter0': 'Drive letter, like C:.',
    'v_GS_ENCRYPTABLE_VOLUME.ProtectionStatus0': 'BitLocker protection: 1 = on, 0 = off, 2 = unknown.',
    'v_GS_BITLOCKER_DETAILS.DriveLetter0': 'Drive letter, like C:.',
    'v_GS_BITLOCKER_DETAILS.ProtectionStatus0': 'BitLocker protection: 1 = on, 0 = off, 2 = unknown.',

    // Network
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.IPAddress0': 'IP addresses, IPv4 and IPv6, separated by commas.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.MACAddress0': 'MAC address.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.IPEnabled0': '1 = adapter has an IP setup. Filter on it to skip virtual and unused adapters.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.DNSHostName0': 'Host name this adapter registers in DNS.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.DNSDomain0': 'DNS suffix for this adapter.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.DefaultIPGateway0': 'Default gateway.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.DHCPEnabled0': '1 = gets its address from DHCP.',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION.Description0': 'Adapter name, like "Intel(R) Wi-Fi 6E AX211 160MHz".',

    // Software
    'v_GS_ADD_REMOVE_PROGRAMS.DisplayName0': 'Program name as Programs and Features shows it. On 64-bit Windows this view has the 32-bit programs; 64-bit ones are in v_GS_ADD_REMOVE_PROGRAMS_64.',
    'v_GS_ADD_REMOVE_PROGRAMS.Version0': 'Program version.',
    'v_GS_ADD_REMOVE_PROGRAMS.Publisher0': 'Publisher.',
    'v_GS_ADD_REMOVE_PROGRAMS.InstallDate0': 'Install date as the installer wrote it: often yyyymmdd text, sometimes blank.',
    'v_GS_ADD_REMOVE_PROGRAMS.ProdID0': 'Product code or uninstall key name.',
    'v_GS_ADD_REMOVE_PROGRAMS_64.DisplayName0': 'Program name as Programs and Features shows it (64-bit programs).',
    'v_GS_ADD_REMOVE_PROGRAMS_64.Version0': 'Program version.',
    'v_GS_ADD_REMOVE_PROGRAMS_64.Publisher0': 'Publisher.',
    'v_GS_ADD_REMOVE_PROGRAMS_64.InstallDate0': 'Install date as the installer wrote it: often yyyymmdd text, sometimes blank.',
    'v_Add_Remove_Programs.DisplayName0': 'Program name as Programs and Features shows it, 32-bit and 64-bit together.',
    'v_Add_Remove_Programs.Version0': 'Program version.',
    'v_Add_Remove_Programs.Publisher0': 'Publisher.',
    'v_GS_INSTALLED_SOFTWARE.ProductName0': 'Program name.',
    'v_GS_INSTALLED_SOFTWARE.ProductVersion0': 'Program version.',
    'v_GS_INSTALLED_SOFTWARE.Publisher0': 'Publisher.',
    'v_GS_INSTALLED_SOFTWARE.InstallDate0': 'When it was installed.',
    'v_GS_INSTALLED_SOFTWARE.InstalledLocation0': 'Install folder.',
    'v_GS_INSTALLED_SOFTWARE.ARPDisplayName0': 'Name as Programs and Features shows it.',
    'v_GS_QUICK_FIX_ENGINEERING.HotFixID0': 'KB number, like KB5031354.',
    'v_GS_QUICK_FIX_ENGINEERING.InstalledOn0': 'Install date as Windows reports it (text).',
    'v_GS_QUICK_FIX_ENGINEERING.Description0': 'Kind of update: Update, Security Update...',

    // Usage and client health
    'v_GS_SYSTEM_CONSOLE_USAGE.TopConsoleUser0': 'User with the most time signed in at the device, from the Windows security log.',
    'v_GS_SYSTEM_CONSOLE_USAGE.TotalConsoleUsers0': 'How many different users signed in at the device.',
    'v_GS_SYSTEM_CONSOLE_USAGE.SecurityLogStartDate0': 'Oldest security log entry the console numbers are based on.',
    'v_GS_WORKSTATION_STATUS.LastHWScan': 'When hardware inventory last ran on the device.',
    'v_CH_ClientSummary.ClientActiveStatus': '1 = active client, 0 = inactive.',
    'v_CH_ClientSummary.LastActiveTime': 'Last time the client showed any sign of life (policy, heartbeat, inventory, status).',
    'v_CH_ClientSummary.LastOnline': 'Last time the client was online to its management point.',
    'v_CH_ClientSummary.LastDDR': 'Last heartbeat discovery.',
    'v_CH_ClientSummary.LastHW': 'Last hardware inventory.',
    'v_CH_ClientSummary.LastSW': 'Last software inventory.',
    'v_CH_ClientSummary.LastPolicyRequest': 'Last time the client asked for policy.',
    'v_CH_ClientSummary.LastHealthEvaluation': 'Last time the client ran its health check.',
    'v_CH_ClientSummary.ClientStateDescription': 'Overall health in words, like "Active/Pass".',

    // Collections
    'v_FullCollectionMembership.Name': 'Device or user name.',
    'v_FullCollectionMembership.IsDirect': '1 = added by a direct rule; 0 = by a query or include rule.',
    'v_FullCollectionMembership.IsClient': '1 = has the ConfigMgr client.',

    // Updates
    'v_UpdateInfo.ArticleID': 'KB number without "KB", like 5031354.',
    'v_UpdateInfo.BulletinID': 'Security bulletin ID, like MS17-010 (older updates only).',
    'v_UpdateInfo.Title': 'Update name.',
    'v_UpdateInfo.IsExpired': '1 = Microsoft expired the update.',
    'v_UpdateInfo.IsSuperseded': '1 = a newer update replaces it.',
    'v_UpdateInfo.IsDeployed': '1 = deployed to at least one collection.',
    'v_UpdateInfo.DatePosted': 'When Microsoft released it.',
    'v_UpdateInfo.Severity': 'Severity as a number: 10 = Critical, 8 = Important, 6 = Moderate, 2 = Low.',
    'v_UpdateComplianceStatus.Status': '0 = unknown, 1 = not needed, 2 = needed (missing), 3 = installed.',
    'v_UpdateComplianceStatus.LastStatusCheckTime': 'When the device last checked whether it needs the update.',
    'v_UpdateComplianceStatus.LastErrorCode': 'Last install error, if any (0 = none).',

    // Deployments
    'v_ClientAdvertisementStatus.LastStateName': 'Latest state in words, like Succeeded or Failed.',
    'v_ClientAdvertisementStatus.LastStatusTime': 'When that state was reported.',
    'v_ClientAdvertisementStatus.LastExecutionResult': 'Exit code from the last run (0 = success).',
  };

  // fn_rbac_GS_X -> v_GS_X; v_HS_X -> v_GS_X
  function currentViewOf(view) {
    let v = view.startsWith('fn_rbac_') ? 'v_' + view.slice(8) : view;
    if (v.startsWith('v_HS_')) v = 'v_GS_' + v.slice(5);
    return v;
  }

  function describe(view, column) {
    return BY_VIEW[view + '.' + column] || BY_VIEW[currentViewOf(view) + '.' + column] || ANY[column] || '';
  }

  const api = { describe, currentViewOf, count: () => Object.keys(BY_VIEW).length + Object.keys(ANY).length };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VWhereColumns = api;
})(this);
