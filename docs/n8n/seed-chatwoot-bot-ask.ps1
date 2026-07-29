# Seed Chatwoot labels + macros for QuizVerse Email bot-ask vs manual.
# Usage:
#   $env:CHATWOOT_API_TOKEN = '<Profile Access Token>'
#   .\docs\n8n\seed-chatwoot-bot-ask.ps1

$ErrorActionPreference = 'Stop'
$Base = if ($env:CHATWOOT_BASE) { $env:CHATWOOT_BASE.TrimEnd('/') } else { 'https://inbox.intelli-verse-x.ai' }
$AccountId = if ($env:CHATWOOT_ACCOUNT_ID) { $env:CHATWOOT_ACCOUNT_ID } else { '1' }
$Token = $env:CHATWOOT_API_TOKEN

if (-not $Token) {
  Write-Error 'Set CHATWOOT_API_TOKEN to your Chatwoot Profile Access Token, then re-run.'
}

$Headers = @{
  'api_access_token' = $Token
  'Content-Type'     = 'application/json'
}

function Invoke-Cw {
  param([string]$Method, [string]$Path, $Body = $null)
  $uri = "$Base/api/v1/accounts/$AccountId$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers
  }
  $json = $Body | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
}

$Ask = @(
  'Thanks for reaching out to QuizVerse Support.',
  '',
  'To help us follow up, please reply with:',
  '1) Your mobile number with country code (example: +916378978141)',
  '2) Your country (example: India)',
  '',
  'You can reply in one line like:',
  'PHONE:+916378978141 COUNTRY:India',
  '',
  'We will reach out with next steps after we receive this.'
) -join "`n"

Write-Host "Chatwoot: $Base account=$AccountId"

$wantedLabels = @(
  @{ title = 'bot-ask-phone'; color = '#1F93FF'; description = 'Admin chose bot ask for phone/country' },
  @{ title = 'bot-ask-sent';  color = '#7E57C2'; description = 'Bot ask email already sent (idempotency)' },
  @{ title = 'manual';        color = '#757575'; description = 'Admin handles this conversation manually' },
  @{ title = 'ready_to_call'; color = '#44CE4B'; description = 'Phone present - voice queue eligible' }
)

$existingLabels = @()
try {
  $labelResp = Invoke-Cw -Method GET -Path '/labels'
  if ($labelResp.payload) { $existingLabels = @($labelResp.payload) }
  elseif ($labelResp -is [System.Array]) { $existingLabels = @($labelResp) }
  else { $existingLabels = @($labelResp) }
} catch {
  Write-Warning ('List labels failed: {0}' -f $_.Exception.Message)
}

$existingTitles = @{}
foreach ($l in $existingLabels) {
  if ($l.title) { $existingTitles[$l.title.ToLower()] = $true }
}

foreach ($lab in $wantedLabels) {
  if ($existingTitles.ContainsKey($lab.title.ToLower())) {
    Write-Host ('Label OK (exists): {0}' -f $lab.title)
    continue
  }
  try {
    Invoke-Cw -Method POST -Path '/labels' -Body $lab | Out-Null
    Write-Host ('Label created: {0}' -f $lab.title)
  } catch {
    Write-Warning ('Label {0} failed: {1}' -f $lab.title, $_.Exception.Message)
  }
}

$macrosWanted = @(
  @{
    name = 'Bot ask phone'
    actions = @(
      @{ action_name = 'add_label'; action_params = @('bot-ask-phone') },
      @{ action_name = 'send_message'; action_params = @($Ask) }
    )
  },
  @{
    name = 'Handle manual'
    actions = @(
      @{ action_name = 'add_label'; action_params = @('manual') }
    )
  }
)

$existingMacros = @()
try {
  $macroResp = Invoke-Cw -Method GET -Path '/macros'
  if ($macroResp.payload) { $existingMacros = @($macroResp.payload) }
  elseif ($macroResp -is [System.Array]) { $existingMacros = @($macroResp) }
  else { $existingMacros = @($macroResp) }
} catch {
  Write-Warning ('List macros failed: {0}' -f $_.Exception.Message)
}

$macroNames = @{}
foreach ($m in $existingMacros) {
  if ($m.name) { $macroNames[$m.name.ToLower()] = $m }
}

foreach ($mac in $macrosWanted) {
  $key = $mac.name.ToLower()
  $body = @{
    name       = $mac.name
    visibility = 'global'
    actions    = $mac.actions
  }
  try {
    if ($macroNames.ContainsKey($key)) {
      $id = $macroNames[$key].id
      Invoke-Cw -Method PATCH -Path ("/macros/{0}" -f $id) -Body $body | Out-Null
      Write-Host ('Macro updated: {0} (id={1})' -f $mac.name, $id)
    } else {
      $created = Invoke-Cw -Method POST -Path '/macros' -Body $body
      $cid = $created.id
      if (-not $cid -and $created.payload) { $cid = $created.payload.id }
      Write-Host ('Macro created: {0}' -f $mac.name)
      if ($cid) { Write-Host ('  id={0}' -f $cid) }
    }
  } catch {
    Write-Warning ('Macro {0} failed: {1}' -f $mac.name, $_.Exception.Message)
  }
}

Write-Host ''
Write-Host 'Done. Agent usage:'
Write-Host '  Bot path: open conversation -> Macros -> Bot ask phone'
Write-Host '  Manual:   Macros -> Handle manual'
Write-Host 'Ensure Chatwoot webhook includes conversation_updated + message_created ->'
Write-Host '  https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready'
