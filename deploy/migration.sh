#!/usr/bin/env bash
#
# Run the database-migration task as a one-off ECS task and block until it finishes, exiting
# non-zero unless its container exited 0. The deploy pipeline gates the service rollout on this
# script, so "the migration failed" and "the migration never started" must both be loud.
#
# Usage:
#   deploy/migration.sh <task-family> <cluster> <task-definition-arn>
#
# All three arguments are required and none of them are baked in: every environment-specific name
# reaches this script from the workflow, which reads it from a GitHub Environment secret/variable.
#
# Optional environment overrides:
#   ECS_LAUNCH_TYPE   launch type passed to run-task (default: EC2)
#   POLL_INTERVAL     seconds between describe-tasks polls (default: 15)
#   POLL_DEADLINE     seconds to wait before giving up (default: 1500, i.e. 25 minutes)

set -euo pipefail

TASK_FAMILY="${1:?Error: missing task family (arg 1) — example: app-migration-staging}"
CLUSTER="${2:?Error: missing ECS cluster (arg 2) — example: my-cluster-staging}"
TASK_DEFINITION="${3:?Error: missing task definition ARN or family:revision (arg 3)}"

LAUNCH_TYPE="${ECS_LAUNCH_TYPE:-EC2}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
# `aws ecs wait tasks-stopped` is deliberately not used: it gives up after a fixed ~10 minutes,
# which is shorter than a large migration. Poll to our own, longer deadline instead.
POLL_DEADLINE="${POLL_DEADLINE:-1500}"
# describe-tasks can transiently return nothing for a task that exists. Tolerate a few of those
# before concluding the task is gone, but do not tolerate them forever.
MAX_UNKNOWN_READS=8

echo "Running migration task"
echo "  family:     ${TASK_FAMILY}"
echo "  cluster:    ${CLUSTER}"
echo "  definition: ${TASK_DEFINITION}"

RUN_TASK_OUTPUT="$(
  aws ecs run-task \
    --cluster "${CLUSTER}" \
    --task-definition "${TASK_DEFINITION}" \
    --launch-type "${LAUNCH_TYPE}" \
    --count 1 \
    --started-by "deploy-migration" \
    --output json
)"

TASK_ARN="$(printf '%s' "${RUN_TASK_OUTPUT}" | jq -r '.tasks[0].taskArn // empty')"

# A placement failure (no capacity, no matching container instance) is reported as HTTP 200 with an
# empty `tasks` array and a populated `failures` array. Without this check the script would happily
# poll a task that was never created and then report success.
if [ -z "${TASK_ARN}" ]; then
  echo "✗ run-task returned no task. Failures:" >&2
  printf '%s' "${RUN_TASK_OUTPUT}" | jq '.failures' >&2
  exit 1
fi

echo "Started ${TASK_ARN}"

ELAPSED=0
UNKNOWN_READS=0
LAST_STATUS=""

while [ "${ELAPSED}" -lt "${POLL_DEADLINE}" ]; do
  DESCRIBE_OUTPUT="$(
    aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --output json
  )"
  LAST_STATUS="$(printf '%s' "${DESCRIBE_OUTPUT}" | jq -r '.tasks[0].lastStatus // empty')"

  if [ -z "${LAST_STATUS}" ]; then
    UNKNOWN_READS=$((UNKNOWN_READS + 1))
    echo "  describe-tasks returned no task (${UNKNOWN_READS}/${MAX_UNKNOWN_READS})"
    if [ "${UNKNOWN_READS}" -ge "${MAX_UNKNOWN_READS}" ]; then
      echo "✗ Task ${TASK_ARN} could not be described ${MAX_UNKNOWN_READS} times in a row." >&2
      printf '%s' "${DESCRIBE_OUTPUT}" | jq '.failures' >&2
      exit 1
    fi
  else
    UNKNOWN_READS=0
    echo "  [${ELAPSED}s] ${LAST_STATUS}"
    if [ "${LAST_STATUS}" = "STOPPED" ]; then
      break
    fi
  fi

  sleep "${POLL_INTERVAL}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [ "${LAST_STATUS}" != "STOPPED" ]; then
  echo "✗ Task ${TASK_ARN} did not stop within ${POLL_DEADLINE}s (last status: ${LAST_STATUS:-unknown})." >&2
  exit 1
fi

FINAL_OUTPUT="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --output json)"
STOPPED_REASON="$(printf '%s' "${FINAL_OUTPUT}" | jq -r '.tasks[0].stoppedReason // "unknown"')"
CONTAINER_REASON="$(printf '%s' "${FINAL_OUTPUT}" | jq -r '.tasks[0].containers[0].reason // ""')"
EXIT_CODE="$(printf '%s' "${FINAL_OUTPUT}" | jq -r '.tasks[0].containers[0].exitCode // empty')"

echo "Task stopped. reason: ${STOPPED_REASON}"
[ -n "${CONTAINER_REASON}" ] && echo "Container reason: ${CONTAINER_REASON}"

# A container that never started has NO exitCode at all. Treating "empty" as "not zero" is the
# whole point: an unset exit code must fail the deploy, never pass it.
if [ -z "${EXIT_CODE}" ]; then
  echo "✗ Container reported no exit code — it never ran to completion." >&2
  exit 1
fi

if [ "${EXIT_CODE}" != "0" ]; then
  echo "✗ Migration container exited ${EXIT_CODE}." >&2
  exit 1
fi

echo "✓ Migration completed (exit code 0)."
