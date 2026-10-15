$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$pipe = $null
$script:deadline = [DateTime]::UtcNow
$script:stage = 'input'
function Fail([string]$code) { [Console]::Out.WriteLine((@{ok=$false;code=$code;stage=$script:stage;privateDiagnosticsOmitted=$true} | ConvertTo-Json -Compress)) }
function Budget { $left=[int][Math]::Ceiling(($script:deadline-[DateTime]::UtcNow).TotalMilliseconds); if($left -lt 1){throw 'TIMEOUT'}; return $left }
function Fields($value, [string[]]$allowed) {
 if($null -eq $value -or $value -isnot [pscustomobject]){throw 'IO'}
 foreach($name in $value.PSObject.Properties.Name){if($name -notin $allowed){throw 'IO'}}
}
function ExactBytes($stream,[int]$length) {
 $buffer=[byte[]]::new($length);$offset=0
 while($offset -lt $length){$task=$stream.ReadAsync($buffer,$offset,$length-$offset);if(-not $task.Wait((Budget))){throw 'TIMEOUT'};if($task.Result -le 0){throw 'IO'};$offset+=$task.Result}
 return ,$buffer
}
Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'))
$owners=@{}
$hostIdentity=$null
while ($null -ne ($inputText=[Console]::In.ReadLine())) {
 $pipe=$null;$script:stage='input'
 try {
 if($inputText.Length -gt 300000){throw 'IO'}
 $inputData=$inputText | ConvertFrom-Json
 Fields $inputData @('requestJson','timeoutMs','maxFrameBytes','maxCandidates','expectedProcessId','expectedProcessStartedAt')
 foreach($spec in @(@('timeoutMs',1,60000),@('maxFrameBytes',4096,4194304),@('maxCandidates',1,32))){$value=$inputData.($spec[0]);if($value -isnot [int] -or $value -lt $spec[1] -or $value -gt $spec[2]){throw 'IO'}}
 $script:deadline=[DateTime]::UtcNow.AddMilliseconds($inputData.timeoutMs)
 if($inputData.requestJson -isnot [string] -or ($null -ne $inputData.expectedProcessId -and ($inputData.expectedProcessId -isnot [int] -or $inputData.expectedProcessId -lt 1))){throw 'IO'}
 if(($null -eq $inputData.expectedProcessId) -ne ($null -eq $inputData.expectedProcessStartedAt)){throw 'IO'}
 if($null -ne $inputData.expectedProcessStartedAt -and ($inputData.expectedProcessStartedAt -isnot [string] -or $inputData.expectedProcessStartedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$')){throw 'IO'}
 $request=$inputData.requestJson | ConvertFrom-Json
 Fields $request @('jsonrpc','id','method','params')
 foreach($key in @('jsonrpc','id','method')){if($request.($key) -isnot [string]){throw 'IO'}}
 if($request.jsonrpc -ne '2.0' -or $request.id -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'IO'}
 $params=$request.params
 if($request.method -eq 'tools/list'){
  Fields $params @('threadStartKind');if($params.threadStartKind -isnot [string] -or $params.threadStartKind -ne 'all'){throw 'IO'}
 }elseif($request.method -eq 'tools/call'){
  Fields $params @('arguments','callId','namespace','threadId','tool','turnId','callerSource')
  foreach($key in @('namespace','callerSource','threadId','callId','turnId','tool')){if($params.($key) -isnot [string]){throw 'IO'}}
  # Reads use acb-readonly-, the one ID-addressed write (set_thread_title) acb-write-; anything else is refused.
  $id='^[A-Za-z0-9_-]{1,200}$';$uuid='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  $prefix=if($params.tool -ceq 'set_thread_title'){'acb-write-'}else{'acb-readonly-'}
  if($params.namespace -ne 'codex_app' -or $params.callerSource -ne 'codex' -or $params.threadId -notmatch $uuid -or $params.callId -cnotmatch ('^'+$prefix+'[a-f0-9-]{36}$') -or $params.turnId -cnotmatch ('^'+$prefix+'[a-f0-9-]{36}$')){throw 'IO'}
  $a=$params.arguments
  $text={param($value,[int]$max) $value -is [string] -and $value.Trim().Length -gt 0 -and $value.Length -le $max -and $value -notmatch '[\x00-\x08\x0b\x0c\x0e-\x1f]'}
  if($params.tool -eq 'list_threads'){Fields $a @('limit');if($a.limit -isnot [int] -or $a.limit -notin @(1,30)){throw 'IO'}}
  elseif($params.tool -eq 'read_thread'){
   Fields $a @('threadId','turnLimit','includeOutputs','maxOutputCharsPerItem')
   if($a.threadId -isnot [string] -or $a.threadId -notmatch $uuid -or $a.turnLimit -isnot [int] -or $a.turnLimit -ne 1 -or $a.includeOutputs -isnot [bool] -or $a.maxOutputCharsPerItem -isnot [int] -or -not (($a.includeOutputs -ceq $false -and $a.maxOutputCharsPerItem -eq 0) -or ($a.includeOutputs -ceq $true -and $a.maxOutputCharsPerItem -eq 20000))){throw 'IO'}
  }elseif($params.tool -eq 'list_projects'){Fields $a @()}
  elseif($params.tool -ceq 'set_thread_title'){
   Fields $a @('source','threadId','title')
   if($a.source -cnotin @('codex','chatgpt') -or $a.threadId -notmatch $uuid -or -not (& $text $a.title 200) -or $a.title -match '\n'){throw 'IO'}
  }else{throw 'IO'}
 }else{throw 'IO'}
 $script:stage='load-native'
 if(-not ('AcbNativeReadonly' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AcbNativeReadonly {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle handle, out uint processId);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
 }
 $foreground=[AcbNativeReadonly]::GetForegroundWindow()
 $session=(Get-Process -Id $PID).SessionId
 $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $script:stage='pipe-discovery'
 $names=@([System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object{[System.IO.Path]::GetFileName($_)} | Where-Object{$_ -match '^codex-browser-use-[a-f0-9-]+$'})
 if($names.Count -eq 0 -or $names.Count -gt $inputData.maxCandidates){throw 'OWNER'}
 $script:stage='host-verification'
 $verified=@()
 foreach($name in $names){
  $candidate=[System.IO.Pipes.NamedPipeClientStream]::new('.',$name,[System.IO.Pipes.PipeDirection]::InOut,[System.IO.Pipes.PipeOptions]::Asynchronous)
  try{
   $candidate.Connect([Math]::Min(250,(Budget)))
   [uint32]$peerId=0
   if(-not [AcbNativeReadonly]::GetNamedPipeServerProcessId($candidate.SafePipeHandle,[ref]$peerId)){continue}
   $owner=Get-Process -Id $peerId
   if($owners.ContainsKey($peerId) -and $owners[$peerId].startedAt -ne $owner.StartTime.ToUniversalTime().ToString('o')){throw 'OWNER'}
   if(-not $owners.ContainsKey($peerId)){
    $version=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($owner.Path)
    $signature=Get-AuthenticodeSignature -LiteralPath $owner.Path
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$peerId)
    $ownerSid=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    $owners[$peerId]=@{ok=($owner.SessionId -eq $session -and $ownerSid.ReturnValue -eq 0 -and $ownerSid.Sid -eq $sid -and $version.ProductName -eq 'Codex' -and $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?:^|,\s*)O=(?:"OpenAI OpCo, LLC"|OpenAI)(?:,|$)');version=$version.FileVersion;startedAt=$owner.StartTime.ToUniversalTime().ToString('o')}
   }
   if($owners[$peerId].ok){$verified+=@{name=$name;processId=$peerId;version=$owners[$peerId].version;startedAt=$owners[$peerId].startedAt}}
  }catch{if([DateTime]::UtcNow -ge $deadline){throw 'TIMEOUT'}}finally{$candidate.Dispose()}
 }
 $processIds=@($verified | ForEach-Object{$_.processId} | Sort-Object -Unique)
 if($processIds.Count -ne 1 -or ($null -ne $inputData.expectedProcessId -and $processIds[0] -ne $inputData.expectedProcessId)){throw 'OWNER'}
 $selected=$verified[0]
 if($null -ne $hostIdentity -and ($hostIdentity.processId -ne $selected.processId -or $hostIdentity.startedAt -ne $selected.startedAt)){throw 'OWNER'}
 $hostIdentity=$selected
 if($null -ne $inputData.expectedProcessStartedAt -and $selected.startedAt -ne $inputData.expectedProcessStartedAt){throw 'OWNER'}
 $script:stage='connect'
 $pipe=[System.IO.Pipes.NamedPipeClientStream]::new('.',$selected.name,[System.IO.Pipes.PipeDirection]::InOut,[System.IO.Pipes.PipeOptions]::Asynchronous)
 $pipe.Connect([Math]::Min(1000,(Budget)))
 [uint32]$connectedId=0
 if(-not [AcbNativeReadonly]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$connectedId) -or $connectedId -ne $selected.processId){throw 'OWNER'}
 if((Get-Process -Id $connectedId).StartTime.ToUniversalTime().ToString('o') -ne $selected.startedAt){throw 'OWNER'}
 $script:stage='frame-write'
 # Forward the Node-created JSON unchanged, on the very handle whose peer was checked.
 $payload=[System.Text.Encoding]::UTF8.GetBytes($inputData.requestJson)
 if($payload.Length -gt $inputData.maxFrameBytes){throw 'IO'}
 $header=[System.BitConverter]::GetBytes([uint32]$payload.Length)
 foreach($part in @($header,$payload)){$write=$pipe.WriteAsync($part,0,$part.Length);if(-not $write.Wait((Budget))){throw 'TIMEOUT'}}
 $script:stage='frame-read'
 $size=[System.BitConverter]::ToUInt32((ExactBytes $pipe 4),0)
 if($size -eq 0 -or $size -gt $inputData.maxFrameBytes){throw 'IO'}
 $utf8=[System.Text.UTF8Encoding]::new($false,$true)
 $response=$utf8.GetString((ExactBytes $pipe ([int]$size))) | ConvertFrom-Json
 $script:stage='response-shape'
 if($response.jsonrpc -ne '2.0' -or $response.id -ne $request.id){throw 'IO'}
 $envelope=@{ok=$true;peer=@{sameUserSignedHost=$true;processId=$connectedId;processStartedAt=$selected.startedAt;appVersion=$selected.version;foregroundUnchanged=([AcbNativeReadonly]::GetForegroundWindow() -eq $foreground)};response=$response}
 $script:stage='output'
 [Console]::Out.WriteLine(($envelope | ConvertTo-Json -Depth 40 -Compress))
}catch{if($_.Exception.Message -eq 'TIMEOUT'){Fail 'TIMEOUT'}elseif($_.Exception.Message -eq 'OWNER'){Fail 'OWNER'}else{Fail 'IO'}}finally{if($null -ne $pipe){$pipe.Dispose()}}

}
