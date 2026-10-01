#!/usr/bin/env bash
# Deploy PetCheck to AWS: Lambda + public HTTPS Function URL, EventBridge
# Scheduler (missed-task check every 5 min) and optional SNS email alerts.
#   npm run deploy
# First run creates everything; later runs just update code and settings.
#
# Owner email alerts: add ALERT_EMAIL=you@example.com to .env.deploy, re-deploy,
# then click the confirmation link AWS emails you.
set -euo pipefail
cd "$(dirname "$0")/.."

FN="petcheck-mcp"
ROLE="petcheck-lambda-role"
SCHED_ROLE="petcheck-scheduler-role"
SCHEDULE="petcheck-missed-check"
TOPIC="petcheck-alerts"
TABLE="${TABLE_NAME:-petcheck}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
REGION="${REGION:-us-east-1}"
HOUSEHOLD_TZ="${HOUSEHOLD_TZ:-America/Detroit}"
# Simulated Alexa+ model (Amazon Bedrock). Override in .env.deploy, e.g.
#   BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0
export AWS_REGION="$REGION" AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Deploying $FN to account $ACCOUNT in $REGION"

# API key: generated once, kept in .env.deploy (git-ignored). Never commit it.
if [ -f .env.deploy ]; then source .env.deploy; fi
BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-us.amazon.nova-lite-v1:0}"
if [ -z "${API_KEY:-}" ]; then
  API_KEY=$(openssl rand -hex 24)
  echo "API_KEY=$API_KEY" > .env.deploy
  echo "Generated a new API key (saved in .env.deploy)"
fi

echo "1/7 Building..."
node scripts/build-lambda.mjs
rm -f dist/petcheck-lambda.zip
(cd dist/lambda && zip -q -r ../petcheck-lambda.zip .)

echo "2/7 Owner alerts (SNS)..."
TOPIC_ARN=""
if [ -n "${ALERT_EMAIL:-}" ]; then
  TOPIC_ARN=$(aws sns create-topic --name "$TOPIC" --tags Key=project,Value=petcheck --query TopicArn --output text)
  if ! aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query 'Subscriptions[].Endpoint' --output text | grep -qi "$ALERT_EMAIL"; then
    aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
    echo "   subscribed $ALERT_EMAIL — check your inbox and click \"Confirm subscription\""
  else
    echo "   $ALERT_EMAIL already subscribed"
  fi
else
  echo "   skipped (set ALERT_EMAIL in .env.deploy to get owner alerts by email)"
fi

echo "3/7 IAM role..."
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "   created $ROLE (waiting for IAM to propagate...)"
  sleep 10
fi
# Least privilege: only this table (and the alert topic), only the calls PetCheck makes.
SNS_STATEMENT=""
if [ -n "$TOPIC_ARN" ]; then
  SNS_STATEMENT=",{\"Effect\":\"Allow\",\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC_ARN\"}"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name petcheck-dynamodb --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": [\"dynamodb:Query\", \"dynamodb:BatchWriteItem\", \"dynamodb:PutItem\"],
    \"Resource\": \"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"
  },{
    \"Effect\": \"Allow\",
    \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
    \"Resource\": [\"arn:aws:bedrock:*::foundation-model/*\", \"arn:aws:bedrock:*:$ACCOUNT:inference-profile/*\"]
  }$SNS_STATEMENT]
}"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "4/7 Lambda function..."
ENV_JSON="{\"Variables\":{\"STORAGE\":\"dynamodb\",\"TABLE_NAME\":\"$TABLE\",\"HOUSEHOLD_TZ\":\"$HOUSEHOLD_TZ\",\"API_KEY\":\"$API_KEY\",\"ALERT_TOPIC_ARN\":\"$TOPIC_ARN\",\"BEDROCK_MODEL_ID\":\"$BEDROCK_MODEL_ID\",\"NODE_OPTIONS\":\"--enable-source-maps\"}}"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file fileb://dist/petcheck-lambda.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --environment "$ENV_JSON" --timeout 30 --memory-size 512 >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  echo "   updated $FN"
else
  for attempt in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN" \
        --runtime nodejs22.x --architectures arm64 \
        --handler lambda.handler --role "$ROLE_ARN" \
        --zip-file fileb://dist/petcheck-lambda.zip \
        --timeout 30 --memory-size 512 \
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

echo "5/7 Function URL..."
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

echo "6/7 Missed-task schedule (every 5 minutes)..."
FN_ARN=$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHED_ROLE" \
    --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"scheduler.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT\"}}}]}" >/dev/null
  echo "   created $SCHED_ROLE (waiting for IAM to propagate...)"
  sleep 10
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name invoke-petcheck \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"$FN_ARN\"}]}"
TARGET_FILE=$(mktemp)
cat > "$TARGET_FILE" <<JSON
{
  "Arn": "$FN_ARN",
  "RoleArn": "arn:aws:iam::$ACCOUNT:role/$SCHED_ROLE",
  "Input": "{\"petcheck\":\"check-missed\"}",
  "RetryPolicy": { "MaximumRetryAttempts": 1 }
}
JSON
SCHED_ARGS=(--name "$SCHEDULE" --schedule-expression "rate(5 minutes)" --flexible-time-window Mode=OFF \
  --target "file://$TARGET_FILE" --description "PetCheck: raise alerts for overdue pet care tasks")
if aws scheduler get-schedule --name "$SCHEDULE" >/dev/null 2>&1; then
  aws scheduler update-schedule "${SCHED_ARGS[@]}" >/dev/null
  echo "   updated $SCHEDULE"
else
  for attempt in 1 2 3 4 5 6; do
    if aws scheduler create-schedule "${SCHED_ARGS[@]}" >/dev/null 2>/tmp/petcheck-sched.err; then break; fi
    if [ "$attempt" -lt 6 ] && grep -qi "role\|assume\|permission" /tmp/petcheck-sched.err; then
      echo "   scheduler role not ready yet, retrying in 10s..."; sleep 10
    else
      cat /tmp/petcheck-sched.err; exit 1
    fi
  done
  echo "   created $SCHEDULE"
fi
rm -f "$TARGET_FILE"

echo "7/7 Smoke test..."
sleep 2
echo "   health: $(curl -s "$URL/health")"
TOOLS=$(curl -s -X POST "$URL/mcp" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer $API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"' | tr '\n' ' ' || true)
echo "   tools: ${TOOLS:-<none — check CloudWatch logs>}"
CHECK=$(curl -s -X POST "$URL/api/check-missed" -H "content-type: application/json" -H "x-api-key: $API_KEY" -d '{}' || true)
echo "   missed-task check: $(echo "$CHECK" | grep -o '"checkedAt":"[^"]*"' || echo "$CHECK")"

cat <<EOF

✔ PetCheck is live
  Household page: $URL/   (enter the key from .env.deploy once)
  Alexa sim:      $URL/alexa   ·   Split-screen demo: $URL/demo   (Bedrock model: $BEDROCK_MODEL_ID)
  MCP URL:  $URL/mcp
  API:      $URL/api/today   ·   POST $URL/api/check-missed {"time":"18:30"}
  Auth:     x-api-key: <API_KEY from .env.deploy>   (or Authorization: Bearer <key>)
  Schedule: $SCHEDULE runs every 5 minutes
  Logs:     aws logs tail /aws/lambda/$FN --follow
EOF
