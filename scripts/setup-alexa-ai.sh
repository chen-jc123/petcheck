#!/usr/bin/env bash
# One-time setup for Amazon's alexa-ai CLI (Alexa+ MCP Toolkit), following
# developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html
#   bash scripts/setup-alexa-ai.sh
# Reuses the keys from your default AWS CLI profile; nothing secret is printed.
set -euo pipefail
export AWS_PAGER=""
AMAZON_TOOLS_ACCOUNT=372468808636
ROLE_ARN="arn:aws:iam::$AMAZON_TOOLS_ACCOUNT:role/AddOn3PDeveloperToolsRead"

echo "0/5 Checking Node.js (alexa-ai needs 24+)..."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "✖ Node.js $(node -v 2>/dev/null || echo 'not found') is too old. Install Node 24+ (https://nodejs.org or: brew install node@24), then re-run."
  exit 1
fi
echo "   node $(node -v) ✔"

echo "1/5 AWS profile 'alexa-ai-user' (copied from your default profile)..."
KEY_ID=$(aws configure get aws_access_key_id)
SECRET=$(aws configure get aws_secret_access_key)
if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then echo "✖ No default AWS credentials. Run 'aws configure' first."; exit 1; fi
aws configure set aws_access_key_id "$KEY_ID" --profile alexa-ai-user
aws configure set aws_secret_access_key "$SECRET" --profile alexa-ai-user
aws configure set region us-east-1 --profile alexa-ai-user

echo "2/5 AWS profile 'alexa-ai' (assumes Amazon's developer-tools role)..."
aws configure set profile.alexa-ai.role_arn "$ROLE_ARN"
aws configure set profile.alexa-ai.source_profile alexa-ai-user
aws configure set profile.alexa-ai.region us-west-2
if aws sts get-caller-identity --profile alexa-ai --query Arn --output text; then
  echo "   role assumed ✔"
else
  echo "✖ Couldn't assume $ROLE_ARN. Your account may need to be enabled for the Alexa+ MCP Toolkit; see the hackathon Discord / docs."
  exit 1
fi

echo "3/5 Git credential helper for CodeCommit (us-west-2)..."
git config --global "credential.https://git-codecommit.us-west-2.amazonaws.com.helper" '!aws codecommit credential-helper --profile alexa-ai $@'
git config --global "credential.https://git-codecommit.us-west-2.amazonaws.com.UseHttpPath" true

echo "4/5 npm registry for @alexa-ai packages (CodeArtifact; token lasts 12 hours)..."
aws codeartifact login --tool npm --domain alexa-ai --repository npm-packages \
  --domain-owner "$AMAZON_TOOLS_ACCOUNT" --region us-west-2 --namespace @alexa-ai --profile alexa-ai

echo "5/5 Installing @alexa-ai/cli..."
npm install -g @alexa-ai/cli
echo "   alexa-ai $(alexa-ai --version) ✔"

cat <<'MSG'

✔ alexa-ai is installed. Next, sign in with your Amazon developer account:
    alexa-ai configure
(If npm says the token expired later, re-run step 4 by running this script again.)
MSG
