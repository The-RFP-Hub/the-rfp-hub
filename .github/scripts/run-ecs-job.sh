#!/usr/bin/env bash
#
# Start one scheduled maintenance job as a one-off container task, wait for it, and exit with its
# exit code. Called by .github/workflows/jobs-nightly.yml, once per job, with $JOB set.
#
# It lives in a file rather than inline in the workflow for two reasons: the same twenty lines
# would otherwise be duplicated for every job in the matrix AND for the staleness job that follows
# them, and a shell script can be read, reviewed and shellchecked as a shell script.
#
# THE UNCONFIGURED CASE IS THE INTERESTING ONE. The task definition, subnets and security groups
# this needs are operator-provisioned resources that may not exist yet (packages/api/docs/deploy.md
# §"Running the maintenance jobs"). Two different answers are right depending on who is asking:
#
#   * on the SCHEDULE, a missing variable is announced as a warning and the job succeeds. The
#     open-data export is chained to this workflow's conclusion, so failing here would stop the
#     dataset publishing for a resource that has never existed — a regression caused entirely by
#     adding this file. The warning is loud, appears in the run summary, and says what is missing.
#   * on a `workflow_dispatch`, a missing variable FAILS. An operator dispatching this run is
#     asking "is the wiring correct", and a green run that did nothing answers the wrong question.
#
# `DISPATCHED` carries which one it is.

set -euo pipefail

: "${JOB:?JOB is required}"
# Which deployment this run maintains, and the prefix its repository variables carry. Named in the
# messages below because "a variable is unset" is not actionable without saying WHICH environment's.
: "${VAR_PREFIX:?VAR_PREFIX is required (PRODUCTION or STAGING)}"
target_env="${TARGET_ENV:-unknown}"

missing=()
for name in ECS_CLUSTER ECS_TASK_DEFINITION ECS_CONTAINER ECS_SUBNETS ECS_SECURITY_GROUPS; do
  if [ -z "${!name:-}" ]; then missing+=("${VAR_PREFIX}_MAINTENANCE_${name}"); fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  detail="the ${target_env} maintenance task runner is not provisioned: repository variable(s) ${missing[*]} are unset, so '${JOB}' did not run"
  if [ "${DISPATCHED:-false}" = "true" ]; then
    echo "::error::${detail}"
    exit 1
  fi
  echo "::warning::${detail}"
  exit 0
fi

# Built with jq rather than string-concatenated: the container name comes from a repository
# variable, and hand-quoting somebody else's value into a JSON document is how a deploy script
# starts executing it. `packages/api/dist/jobs.js` is the entry point tsup builds alongside
# migrate/seed/export; `--json` makes the task's log line one machine-readable object.
overrides=$(
  jq -nc --arg name "$ECS_CONTAINER" --arg job "$JOB" \
    '{containerOverrides: [{name: $name, command: ["node", "packages/api/dist/jobs.js", $job, "--json"]}]}'
)

network="awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[${ECS_SECURITY_GROUPS}],assignPublicIp=DISABLED}"

echo "starting ${JOB} on ${ECS_TASK_DEFINITION} (${target_env})"
task_arn=$(
  aws ecs run-task \
    --cluster "$ECS_CLUSTER" \
    --task-definition "$ECS_TASK_DEFINITION" \
    --launch-type FARGATE \
    --network-configuration "$network" \
    --overrides "$overrides" \
    --started-by "jobs-nightly/${JOB}" \
    --query 'tasks[0].taskArn' \
    --output text
)

if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "::error::run-task returned no task for '${JOB}' — check the failures array in the API response"
  exit 1
fi
echo "task ${task_arn}"

# `wait tasks-stopped` polls for up to ~10 minutes; the jobs are bounded well inside that, and the
# workflow's own timeout is the outer bound.
aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$task_arn"

exit_code=$(
  aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text
)
reason=$(
  aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' --output text
)

echo "${JOB} stopped: exitCode=${exit_code} reason=${reason}"

# A task that never started a container has a null exit code — an image pull failure, a missing
# secret, no capacity. That is a failure of this job, not an unknown.
if [ "$exit_code" != "0" ]; then
  echo "::error::${JOB} exited ${exit_code} (${reason})"
  exit 1
fi
