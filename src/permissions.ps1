param([Parameter(Mandatory=$true)][string]$TargetPath, [string]$AdditionalSids = '', [switch]$Recursive)
$ErrorActionPreference = 'Stop'
function Read-PathAcl($Item) {
  if ($PSVersionTable.PSVersion.Major -ge 6) { return [IO.FileSystemAclExtensions]::GetAccessControl($Item) }
  return $Item.GetAccessControl()
}
function Write-PathAcl($Item, $Acl) {
  if ($PSVersionTable.PSVersion.Major -ge 6) { [IO.FileSystemAclExtensions]::SetAccessControl($Item, $Acl) }
  else { $Item.SetAccessControl($Acl) }
}
$target = Get-Item -LiteralPath $TargetPath -Force
$items = @($target)
if ($Recursive) { $items += @(Get-ChildItem -LiteralPath $target.FullName -Recurse -Force) }
foreach ($item in $items) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported' }
}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($item in $items) {
  $acl = Read-PathAcl $item
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowed = @($owner, $current, 'S-1-5-18', 'S-1-5-32-544')
  if ($AdditionalSids) { $allowed += $AdditionalSids.Split(',') }
  $allowed = @($allowed | Select-Object -Unique)
  foreach ($sid in $allowed) {
    if ($sid -notmatch '^S-1-\d+(-\d+)+$' -or $sid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545')) { throw 'Invalid or overly broad authorized SID' }
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  foreach ($sid in $allowed) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl,
      $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  Write-PathAcl $item $acl
  $verified = Read-PathAcl $item
  if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }
  foreach ($rule in $verified.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'ACL verification failed' }
  }
}
