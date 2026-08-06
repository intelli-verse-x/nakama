# Creates/updates SSM SecureString /nakama/API_NINJAS_API_KEY and optionally
# applies kube-infra secret + restarts intelliverse-nakama.
#
# Usage:
#   .\scripts\put-api-ninjas-ssm.ps1
#   .\scripts\put-api-ninjas-ssm.ps1 -ApiKey "YOUR_KEY" -ApplyKube
#
# Requires valid AWS creds (aws sts get-caller-identity) and, for -ApplyKube,
# kubectl context for ai-cart-auto-cluster / namespace aicart.

param(
  [string]$ApiKey = $env:API_NINJAS_API_KEY,
  [string]$Region = "us-east-1",
  [string]$ParamName = "/nakama/API_NINJAS_API_KEY",
  [string]$KubeInfraRoot = "C:\Office\intelli-verse-kube-infra",
  [switch]$ApplyKube
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Write-Error "Pass -ApiKey or set env API_NINJAS_API_KEY (do not commit the value)."
}

Write-Host "=== STS ==="
aws sts get-caller-identity --region $Region | Out-Host

Write-Host "=== PutParameter $ParamName (SecureString) ==="
aws ssm put-parameter `
  --region $Region `
  --name $ParamName `
  --type SecureString `
  --value $ApiKey `
  --overwrite | Out-Host

Write-Host "=== Verify (name only) ==="
aws ssm get-parameter `
  --region $Region `
  --name $ParamName `
  --query "Parameter.[Name,Type,LastModifiedDate]" `
  --output table | Out-Host

if ($ApplyKube) {
  $secretPath = Join-Path $KubeInfraRoot "nakama\nakama-secret.yaml"
  if (-not (Test-Path $secretPath)) {
    Write-Error "Missing $secretPath"
  }
  Write-Host "=== kubectl apply secret + rollout restart ==="
  aws eks update-kubeconfig --region $Region --name ai-cart-auto-cluster | Out-Host
  kubectl apply -f $secretPath -n aicart
  kubectl set env deployment/intelliverse-nakama -n aicart "API_NINJAS_API_KEY=$ApiKey"
  kubectl rollout restart deployment/intelliverse-nakama -n aicart
  kubectl rollout status deployment/intelliverse-nakama -n aicart --timeout=900s
  Write-Host "=== Confirm runtime.env line present in mounted config ==="
  kubectl exec -n aicart deploy/intelliverse-nakama -- sh -c "grep -c API_NINJAS /nakama/config/config.yaml && echo FOUND || echo MISSING"
}

Write-Host "Done."
