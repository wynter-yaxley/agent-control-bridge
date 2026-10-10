param([Parameter(Mandatory=$true)][string]$TargetPath, [string]$AdditionalSids = '', [switch]$Recursive)
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('ACB_ACL_PHASE:entered')
function Read-PathAcl($Item) {
  if ($PSVersionTable.PSVersion.Major -ge 6) { return [IO.FileSystemAclExtensions]::GetAccessControl($Item) }
  return $Item.GetAccessControl()
}
function Write-PathAcl($Item, $Acl) {
  if ($PSVersionTable.PSVersion.Major -ge 6) { [IO.FileSystemAclExtensions]::SetAccessControl($Item, $Acl) }
  else { $Item.SetAccessControl($Acl) }
}
$target = if ([IO.Directory]::Exists($TargetPath)) { [IO.DirectoryInfo]::new($TargetPath) } else { [IO.FileInfo]::new($TargetPath) }
if (-not $target.Exists) { throw 'Target does not exist' }
$items = @($target)
if ($Recursive -and $target -is [IO.DirectoryInfo]) {
  $queue = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
  $queue.Enqueue($target)
  while ($queue.Count -gt 0) {
    $directory = $queue.Dequeue()
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported' }
    foreach ($entry in $directory.EnumerateFileSystemInfos()) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported' }
      $items += $entry
      if ($entry -is [IO.DirectoryInfo]) { $queue.Enqueue($entry) }
    }
  }
}
foreach ($item in $items) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported' }
}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($item in $items) {
  [Console]::Out.WriteLine('ACB_ACL_PHASE:read')
  $acl = Read-PathAcl $item
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowed = @($owner, $current, 'S-1-5-18', 'S-1-5-32-544')
  if ($AdditionalSids) { $allowed += $AdditionalSids.Split(',') }
  $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($sid in $allowed) { [void]$unique.Add($sid) }
  $allowed = @($unique)
  foreach ($sid in $allowed) {
    if ($sid -notmatch '^S-1-\d+(-\d+)+$' -or $sid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545')) { throw 'Invalid or overly broad authorized SID' }
  }
  $acl.SetAccessRuleProtection($true, $false)
  [Console]::Out.WriteLine('ACB_ACL_PHASE:rules')
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($item -is [IO.DirectoryInfo]) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  foreach ($sid in $allowed) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl,
      $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  [Console]::Out.WriteLine('ACB_ACL_PHASE:apply')
  Write-PathAcl $item $acl
  [Console]::Out.WriteLine('ACB_ACL_PHASE:verify')
  $verified = Read-PathAcl $item
  if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }
  foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'ACL verification failed' }
  }
}
[Console]::Out.WriteLine('ACB_ACL_PHASE:done')
