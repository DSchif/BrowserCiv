#!/usr/bin/env bash
# Provisions the AWS side of GitHub Actions CD:
#   1. An IAM OIDC identity provider for token.actions.githubusercontent.com (idempotent)
#   2. An IAM role `BrowserCivCIDeployRole` scoped to a specific GitHub repo
#      and ref (default: main branch only) that GH Actions can assume via OIDC
#   3. An inline policy on that role granting sts:AssumeRole on the CDK
#      bootstrap roles, which is all `cdk deploy` actually needs
#
# Usage:
#   scripts/aws-setup-ci.sh <github-owner>/<github-repo> [branch]
#
# Example:
#   scripts/aws-setup-ci.sh dean-anthropic/BrowserCiv main
#
# Output: prints the role ARN to stdout — paste it into the
# AWS_DEPLOY_ROLE GitHub Actions variable (Settings → Secrets and variables
# → Actions → Variables).
#
# Requires: aws CLI logged in as a principal with iam:* on the target account.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <owner>/<repo> [branch=main]" >&2
  exit 2
fi

REPO="$1"
BRANCH="${2:-main}"
ROLE_NAME="BrowserCivCIDeployRole"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
QUALIFIER="hnb659fds"  # default cdk bootstrap qualifier

if [[ ! "$REPO" =~ ^[^/]+/[^/]+$ ]]; then
  echo "error: repo must look like owner/repo (got: $REPO)" >&2
  exit 2
fi

echo "==> account=${ACCOUNT} region=${REGION} repo=${REPO} branch=${BRANCH}"

# 1. OIDC provider — idempotent
PROVIDER_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "==> OIDC provider already exists"
else
  echo "==> creating OIDC provider"
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list ffffffffffffffffffffffffffffffffffffffff >/dev/null
  # GitHub's certificate authority is verified by AWS without thumbprint
  # checking when the URL is token.actions.githubusercontent.com, so the
  # placeholder thumbprint is fine.
fi

# 2. Trust policy: only this repo, only this branch
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${REPO}:ref:refs/heads/${BRANCH}"
        }
      }
    }
  ]
}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "==> role ${ROLE_NAME} exists — updating trust policy"
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
else
  echo "==> creating role ${ROLE_NAME}"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions deploy role for BrowserCiv" \
    --tags Key=Project,Value=BrowserCiv >/dev/null
fi

# 3. Permissions: just enough to run `cdk deploy`. CDK's bootstrap roles do
# all the actual work once we can assume them.
PERMS_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-deploy-role-${ACCOUNT}-${REGION}",
        "arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-file-publishing-role-${ACCOUNT}-${REGION}",
        "arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-image-publishing-role-${ACCOUNT}-${REGION}",
        "arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-lookup-role-${ACCOUNT}-${REGION}"
      ]
    },
    {
      "Sid": "DescribeBootstrapVersion",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cdk-bootstrap/${QUALIFIER}/version"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BrowserCivCIDeployPolicy" \
  --policy-document "$PERMS_POLICY" >/dev/null

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
echo
echo "Role ready:"
echo "  ${ROLE_ARN}"
echo
echo "Next: in GitHub repo settings → Secrets and variables → Actions → Variables,"
echo "add a Repository variable named AWS_DEPLOY_ROLE with this value."
