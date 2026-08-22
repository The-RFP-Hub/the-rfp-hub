#!/usr/bin/env bash
#
# Start one scheduled maintenance job as a one-off container task, wait for it, and exit with its
# exit code. Called by .github/workflows/jobs-nightly.yml, once per job, with $JOB set.
#
# It lives in a file rather than inline in the workflow for two reasons: the same lines would
# otherwise be duplicated for every job in the matrix AND for the staleness job that follows them,
# and a shell script can be read, reviewed and shellchecked as a shell script.
#
# ── IT RUNS ON THE SERVICE'S OWN TASK DEFINITION, AND OWNS NO INFRASTRUCTURE ────────────────────
#
# A job is the deployed image with a different command. Everything it needs — the image, the
# runtime `DATABASE_URL`, every secret in the task definition's `secrets:` array, the execution and
# task roles — is already assembled in the task definition the API service runs, and the deploy
# workflows keep it current. So this reuses it rather than asking an operator to provision and
# maintain a parallel one, which would be a second copy of the same secret list to keep in step.
#
# The names are the ones staging.yml and production.yml already hardcode:
#
#   task definition family / container : rfp-hub-<env>
#   service                            : rfp-hub-<env>-service
#   cluster                            : repository variable <ENV>_ECS_CLUSTER
#
# The first two are DERIVED here, as overridable inputs, so the naming rule has one home rather
# than a copy in the workflow that can drift out of step with it. Only the cluster is a variable,
# because only the cluster is the hosting account's own name.
#
# ── SUBNETS AND SECURITY GROUPS ARE DISCOVERED, NOT CONFIGURED ──────────────────────────────────
#
# `run-task` needs an awsvpc network configuration that `describe-task-definition` does not carry —
# it belongs to the SERVICE. Asking an operator to restate it in repository variables would be
# asking them to keep a copy of the VPC layout in sync by hand, and the failure mode of a stale
# copy is a task that starts in the wrong subnet and cannot reach the database. So the service is
# read at run time and its own network configuration and launch type are reused verbatim: the job
# lands exactly where the API lands, by construction.
#
# ── THE UNPROVISIONED CASE, AND WHY IT HAS TWO ANSWERS ──────────────────────────────────────────
#
# Two things can still be absent: the cluster variable, and the service itself (a deployment that
# has not happened yet). Both are answered differently depending on who is asking:
#
#   * on the SCHEDULE, it is announced as a warning and the job succeeds. The open-data export is
#     chained to this workflow's conclusion, so failing here would stop the dataset publishing over
#     a resource that has never existed — a regression caused entirely by adding this file. The
#     warning is loud, appears in the run summary, and says what is missing.
#   * on a `workflow_dispatch`, it FAILS. An operator dispatching this run is asking "is the wiring
#     correct", and a green run that did nothing answers the wrong question.
#
# `DISPATCHED` carries which one it is.

set -euo pipefail

: "${JOB:?JOB is required}"
: "${TARGET_ENV:?TARGET_ENV is required (production or staging)}"

# The deploy workflows' naming, in one place. Overridable so a deployment that named things
# differently can say so without this script learning a second rule.
task_definition="${ECS_TASK_DEFINITION:-rfp-hub-${TARGET_ENV}}"
container="${ECS_CONTAINER:-${task_definition}}"
service="${ECS_SERVICE:-${task_definition}-service}"
cluster="${ECS_CLUSTER:-}"

# Warn and succeed on a schedule; fail on a dispatch. Never returns.
not_provisioned() {
  if [ "${DISPATCHED:-false}" = "true" ]; then
    echo "::error::$1"
    exit 1
  fi
  echo "::warning::$1"
  exit 0
}

if [ -z "$cluster" ]; then
  # An empty `--cluster` is not an error to ECS, it is a request for the account's `default`
  # cluster — the same trap the deploy workflows guard against before touching AWS.
  not_provisioned "the ${TARGET_ENV} cluster is not configured: repository variable ${TARGET_ENV^^}_ECS_CLUSTER is unset, so '${JOB}' did not run"
fi

# One call, everything read out of it. A service that does not exist is not an AWS error: the call
# succeeds with an empty `services` array and the reason in `failures`, so both shapes are handled.
if ! service_json=$(
  aws ecs describe-services --cluster "$cluster" --services "$service" --output json
); then
  not_provisioned "could not describe ${service} on ${cluster}: the ${TARGET_ENV} deployment is not reachable with these credentials, so '${JOB}' did not run"
fi

network=$(jq -c '.services[0].networkConfiguration.awsvpcConfiguration // empty' <<<"$service_json")
if [ -z "$network" ]; then
  not_provisioned "no service ${service} on cluster ${cluster} (or it has no awsvpc network configuration): deploy the ${TARGET_ENV} API first, so '${JOB}' did not run"
fi

# The service's own placement, verbatim: a Fargate service reports `launchType`, one on a capacity
# provider reports a strategy instead, and reusing whichever it has is what keeps the job on the
# same capacity as the API. FARGATE is the fallback only when the service states neither.
launch_type=$(jq -r '.services[0].launchType // empty' <<<"$service_json")
strategy=$(jq -c '.services[0].capacityProviderStrategy // empty' <<<"$service_json")
placement=()
if [ -n "$launch_type" ]; then
  placement+=(--launch-type "$launch_type")
elif [ -n "$strategy" ] && [ "$strategy" != "[]" ]; then
  placement+=(--capacity-provider-strategy "$strategy")
else
  placement+=(--launch-type FARGATE)
fi

# Built with jq rather than string-concatenated: the container name and the discovered network
# configuration are values from elsewhere, and hand-quoting somebody else's value into a JSON
# document is how a deploy script starts executing it. `packages/api/dist/jobs.js` is the entry
# point tsup builds alongside migrate/seed/export; `--json` makes the task's log line one
# machine-readable object.
overrides=$(
  jq -nc --arg name "$container" --arg job "$JOB" \
    '{containerOverrides: [{name: $name, command: ["node", "packages/api/dist/jobs.js", $job, "--json"]}]}'
)
network_configuration=$(jq -nc --argjson vpc "$network" '{awsvpcConfiguration: $vpc}')

echo "starting ${JOB} on ${task_definition} in ${cluster} (${TARGET_ENV}), placed like ${service}"
task_arn=$(
  aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    "${placement[@]}" \
    --network-configuration "$network_configuration" \
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
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"

exit_code=$(
  aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text
)
reason=$(
  aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' --output text
)

echo "${JOB} stopped: exitCode=${exit_code} reason=${reason}"

# A task that never started a container has a null exit code — an image pull failure, a missing
# secret, no capacity. That is a failure of this job, not an unknown.
if [ "$exit_code" != "0" ]; then
  echo "::error::${JOB} exited ${exit_code} (${reason})"
  exit 1
fi
