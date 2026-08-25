#!/usr/bin/env bash
# ECR digest helpers for Nakama EKS deploys.
#
# Production lives in account 803881282303. The cluster pins images by digest.
# ECR lifecycle keeps only the last ~10 tags, so an old digest in the Deployment
# spec can vanish while Ready pods keep running it from the node cache
# (imagePullPolicy: IfNotPresent). Rolling back to that ghost digest creates
# ImagePullBackOff pods, HPA then scales the dead ReplicaSet, and the new
# image never finishes rolling. See GHA run 32869881198 (2026-08-25).

ecr_registry_id() {
  echo "${AWS_ACCOUNT_ID:-803881282303}"
}

assert_aws_account() {
  local expected="${1:-803881282303}"
  local what="${2:-nakama EKS deploy}"
  local actual
  actual="$(aws sts get-caller-identity --query Account --output text)"
  if [ "$actual" = "$expected" ]; then
    echo "AWS account ${actual} — production. Proceeding with ${what}."
    return 0
  fi
  cat >&2 <<MSG
REFUSING TO RUN: ${what} is pointed at the wrong AWS account.
  credentials are for : ${actual}
  production is       : ${expected}
ai-cart-auto-cluster exists in both accounts. A deploy against ${actual}
would report success and ship nothing customers can reach.
MSG
  return 1
}

digest_only() {
  local ref="${1:-}"
  ref="${ref#*@}"
  ref="${ref#sha256:}"
  if [ -n "$ref" ] && [ "$ref" != "None" ]; then
    echo "sha256:${ref}"
  fi
}

ecr_has_digest() {
  local digest
  digest="$(digest_only "${1:-}")"
  [ -n "$digest" ] || return 1
  local got
  got="$(aws ecr batch-get-image \
    --registry-id "$(ecr_registry_id)" \
    --repository-name "${ECR_REPOSITORY:-intelliverse-nakama}" \
    --image-ids imageDigest="$digest" \
    --query 'images[0].imageId.imageDigest' \
    --output text 2>/dev/null || true)"
  [ "$got" = "$digest" ]
}

ecr_protect_tag() {
  local digest tag manifest
  digest="$(digest_only "${1:-}")"
  tag="${2:-}"
  [ -n "$digest" ] && [ -n "$tag" ] || return 1
  manifest="$(aws ecr batch-get-image \
    --registry-id "$(ecr_registry_id)" \
    --repository-name "${ECR_REPOSITORY:-intelliverse-nakama}" \
    --image-ids imageDigest="$digest" \
    --query 'images[0].imageManifest' \
    --output text 2>/dev/null || true)"
  if [ -z "$manifest" ] || [ "$manifest" = "None" ]; then
    echo "WARN: cannot retag ${digest} as :${tag} — digest not in ECR"
    return 1
  fi
  aws ecr put-image \
    --registry-id "$(ecr_registry_id)" \
    --repository-name "${ECR_REPOSITORY:-intelliverse-nakama}" \
    --image-tag "$tag" \
    --image-manifest "$manifest" >/dev/null
  echo "protected ${digest} as :${tag}"
}

# The Deployment spec may pin a digest ECR already expired. Ready pods still
# run the last image that actually pulled. Prefer that for rollback.
working_image_from_ready_pod() {
  local ns="${1:-aicart}"
  local app="${2:-intelliverse-nakama}"
  local image_id
  image_id="$(kubectl get pods -n "$ns" -l "app=${app},!job-name" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' \
    2>/dev/null || true)"
  image_id="${image_id#docker-pullable://}"
  echo "$image_id"
}

verify_tag_serves_arm64() {
  local ref="${1:?image ref required}"
  local inspect
  inspect="$(docker buildx imagetools inspect "$ref" 2>/dev/null || true)"
  if echo "$inspect" | grep -Eq 'linux/arm64|architecture:[[:space:]]*arm64'; then
    echo "verified ${ref} serves linux/arm64"
    return 0
  fi
  echo "FATAL: ${ref} has no linux/arm64 platform. intelliverse-nakama nodeSelector is kubernetes.io/arch=arm64." >&2
  echo "$inspect" | tail -40 >&2
  return 1
}

pause_hpa() {
  local ns="${1:-aicart}"
  local hpa="${2:-}"
  local replicas="${3:-}"
  [ -n "$hpa" ] || return 0
  if ! kubectl get hpa "$hpa" -n "$ns" >/dev/null 2>&1; then
    echo "HPA ${hpa} not found — skipping pause"
    return 0
  fi
  kubectl get hpa "$hpa" -n "$ns" \
    -o jsonpath='{.spec.minReplicas} {.spec.maxReplicas}' > "/tmp/hpa-${hpa}-minmax"
  if [ -z "$replicas" ] || [ "$replicas" = "0" ]; then
    replicas="$(kubectl get hpa "$hpa" -n "$ns" -o jsonpath='{.status.desiredReplicas}')"
  fi
  [ -n "$replicas" ] || replicas=2
  echo "Pausing HPA ${hpa} at ${replicas} replicas for the rollout"
  kubectl patch hpa "$hpa" -n "$ns" --type=merge \
    --patch "{\"spec\":{\"minReplicas\":${replicas},\"maxReplicas\":${replicas}}}"
}

restore_hpa() {
  local ns="${1:-aicart}"
  local hpa="${2:-}"
  [ -n "$hpa" ] || return 0
  if [ -f "/tmp/hpa-${hpa}-minmax" ]; then
    local min max
    read -r min max < "/tmp/hpa-${hpa}-minmax"
    [ -n "$min" ] || min=2
    [ -n "$max" ] || max=10
    echo "Restoring HPA ${hpa} min=${min} max=${max}"
    kubectl patch hpa "$hpa" -n "$ns" --type=merge \
      --patch "{\"spec\":{\"minReplicas\":${min},\"maxReplicas\":${max}}}" || true
  fi
}

delete_unpullable_pods() {
  local ns="${1:-aicart}"
  local app="${2:-intelliverse-nakama}"
  local pods
  pods="$(kubectl get pods -n "$ns" -l "app=${app},!job-name" \
    --no-headers 2>/dev/null | awk '$3 ~ /ImagePullBackOff|ErrImagePull/ {print $1}' || true)"
  if [ -n "$pods" ]; then
    echo "Deleting ImagePullBackOff pods so they cannot consume maxSurge slots:"
    echo "$pods"
    # shellcheck disable=SC2086
    kubectl delete pod -n "$ns" $pods --wait=false || true
  fi
}
