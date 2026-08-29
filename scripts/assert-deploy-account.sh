#!/usr/bin/env bash
#
# Refuse to build or deploy against an AWS account that does not serve production.
#
# `ai-cart-auto-cluster` exists twice: 970547373533 (being decommissioned) and
# 803881282303 (serves production). `aws eks update-kubeconfig --name
# ai-cart-auto-cluster` picks whichever the ambient credentials belong to.
#
# Usage: assert-deploy-account.sh <expected-account-id> [what-for]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/ecr-digest.sh"

assert_aws_account "${1:?usage: assert-deploy-account.sh <expected-account-id> [what-for]}" "${2:-this workflow}"
