#!/usr/bin/env bash
#
# Assert that an ECS service is actually running the task-definition revision the deploy just
# registered. Without this, a rollout that silently stayed on the old revision reports green: the
# deploy action waits for "service stable", and a service that never changed is trivially stable.
#
# Usage:
#   deploy/check_service_revision.sh <expected-revision> <service> <cluster>
#
# All three arguments are required and none of them are baked in: every environment-specific name
# reaches this script from the workflow, which reads it from a GitHub Environment secret/variable.
#
#   <expected-revision>  the numeric revision the service should now be on (previous + 1)
#   <service>            example: my-service-staging-service
#   <cluster>            example: my-cluster-staging

set -euo pipefail

EXPECTED_REVISION="${1:?Error: missing expected revision (arg 1) — example: 42}"
SERVICE="${2:?Error: missing ECS service name (arg 2)}"
CLUSTER="${3:?Error: missing ECS cluster (arg 3)}"

# Validate the EXPECTED value before reading anything from AWS. If it arrived empty or as a
# non-number (a workflow expression that resolved to nothing, say), a later string comparison
# would quietly match some other garbage value and the check would fail open.
if ! printf '%s' "${EXPECTED_REVISION}" | grep -Eq '^[0-9]+$'; then
  echo "✗ Expected revision '${EXPECTED_REVISION}' is not a number." >&2
  exit 1
fi

TASK_DEFINITION_ARN="$(
  aws ecs describe-services \
    --cluster "${CLUSTER}" \
    --services "${SERVICE}" \
    --query 'services[0].taskDefinition' \
    --output text
)"

if [ -z "${TASK_DEFINITION_ARN}" ] || [ "${TASK_DEFINITION_ARN}" = "None" ]; then
  echo "✗ Could not read the task definition of service '${SERVICE}' on cluster '${CLUSTER}'." >&2
  exit 1
fi

ACTUAL_REVISION="${TASK_DEFINITION_ARN##*:}"

if ! printf '%s' "${ACTUAL_REVISION}" | grep -Eq '^[0-9]+$'; then
  echo "✗ Could not parse a revision number out of '${TASK_DEFINITION_ARN}'." >&2
  exit 1
fi

if [ "${ACTUAL_REVISION}" != "${EXPECTED_REVISION}" ]; then
  echo "✗ Service '${SERVICE}' is on revision ${ACTUAL_REVISION}, expected ${EXPECTED_REVISION}." >&2
  echo "  Active task definition: ${TASK_DEFINITION_ARN}" >&2
  exit 1
fi

echo "✓ Service '${SERVICE}' is on revision ${ACTUAL_REVISION} as expected."
