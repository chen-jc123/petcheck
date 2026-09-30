#!/usr/bin/env bash
# Deploy PetCheck to AWS Lambda with a public HTTPS Function URL.
#   npm run deploy
# First run creates everything; later runs just update code and settings.
set -euo pipefail
cd "$(dirname "$0")/.."

FN="petcheck-mcp"
ROLE="petcheck-lambda-role"
TABLE="${TABLE_NAME:-petcheck}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
REGION="${REGION:-us-east-1}"
HOUSEHOLD_TZ="${HOUSEHOLD_TZ:-America/Detroit}"
export AWS_REGION="$REGION" AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Deploying $FN to account $ACCOUNT in $REGION"

# API key: generated once, kept in .env.deploy (git-ignored). Never commit it.
if [ -f .env.deploy ]; then source .env.deploy; fi
if [ -z "${API_KEY:-}" ]; then
  API_KEY=$(openssl rand -hex 24)
  echo "API_KEY=$API_KEY" > .env.deploy
  echo "Generated a new API key (saved in .env.deploy)"
fi

echo "1/5 Building..."
node scripts/build-lambda.mjs
rm -f dist/petcheck-lambda.zip
(cd dist/lambda && zip -q -r ../petcheck-lambda.zip .)

echo "2/5 IAM role..."
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "   created $ROLE (waiting for IAM to propagate...)"
  sleep 10
fi
# Least privilege: only this table, only the calls PetCheck makes.
aws iam put-role-policy --role-name "$ROLE" --policy-name petcheck-dynamodb --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": [\"dynamodb:Query\", \"dynamodb:BatchWriteItem\", \"dynamodb:PutItem\"],
    \"Resource\": \"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"
  }]
}"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "3/5 Lambda function..."
ENV_JSON="{\"Variables\":{\"STORAGE\":\"dynamodb\",\"TABLE_NAME\":\"$TABLE\",\"HOUSEHOLD_TZ\":\"$HOUSEHOLD_TZ\",\"API_KEY\":\"$API_KEY\",\"NODE_OPTIONS\":\"--enable-source-maps\"}}"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file fileb://dist/petcheck-lambda.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --environment "$ENV_JSON" --timeout 15 --memory-size 512 >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  echo "   updated $FN"
else
  for attempt in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN" \
        --runtime nodejs22.x --architectures arm64 \
        --handler lambda.handler --role "$ROLE_ARN" \
        --zip-file fileb://dist/petcheck-lambda.zip \
        --timeout 15 --memory-size 512 \
        --environment "$ENV_JSON" \
        --tags project=petcheck >/dev/null 2>/tmp/petcheck-create.err; then
      break
    fi
    if grep -q "cannot be assumed" /tmp/petcheck-create.err && [ "$attempt" -lt 6 ]; then
      echo "   role not ready yet, retrying in 10s..."; sleep 10
    else
      cat /tmp/petcheck-create.err; exit 1
    fi
  done
  aws lambda wait function-active-v2 --function-name "$FN"
  echo "   created $FN"
fi

echo "4/5 Function URL..."
if ! aws lambda get-function-url-config --function-name "$FN" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FN" --auth-type NONE >/dev/null
  # The URL itself is public; the app checks the API key on /mcp.
  aws lambda add-permission --function-name "$FN" --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FN" --statement-id FunctionURLInvokeAllowPublicAccess \
    --action lambda:InvokeFunction --principal "*" --invoked-via-function-url >/dev/null 2>&1 || \
    echo "   (note: could not add lambda:InvokeFunction permission; if the URL returns 403, update the AWS CLI and re-run)"
fi
URL=$(aws lambda get-function-url-config --function-name "$FN" --query FunctionUrl --output text)
URL="${URL%/}"

echo "5/5 Smoke test..."
sleep 2
echo "   health: $(curl -s "$URL/health")"
TOOLS=$(curl -s -X POST "$URL/mcp" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"' | tr '\n' ' ' || true)
echo "   tools: ${TOOLS:-<none — check CloudWatch logs>}"

cat <<EOF

✔ PetCheck is live
  MCP URL:  $URL/mcp
  Auth:     Authorization: Bearer <API_KEY from .env.deploy>
  Logs:     aws logs tail /aws/lambda/$FN --follow
EOF
