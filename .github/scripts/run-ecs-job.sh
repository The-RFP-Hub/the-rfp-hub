#!/usr/bin/env bash
#
# Start one scheduled maintenance job as a one-off container task, wait for it, and exit with its
# exit code. Called by .github/workflows/jobs-nightly.yml, once per job, with $JOB set.
#
# It lives in a file rather than inline in the workflow for two reasons: the same lines would
# otherwise be duplicated for every job in the matrix AND for the staleness job beside them, and a
# shell script can be read, reviewed and shellchecked as a shell script.
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
# ── IT RUNS WHERE THE SERVICE RUNS, AND CARRIES NO NETWORK CONFIGURATION ────────────────────────
#
# Placement is READ OFF THE SERVICE at run time rather than restated in configuration: whichever of
# `launchType` or `capacityProviderStrategy` it reports, plus its placement constraints, is passed
# to `run-task` verbatim. Asking an operator to keep a copy of that in repository variables would be
# asking them to keep it in sync by hand, and a stale copy starts the job on capacity the API is
# deliberately kept off. Reading the service means the job lands where the API lands, by
# construction.
#
# There is NO network configuration to pass, because this deployment does not use `awsvpc`. Its
# tasks run in `bridge` mode on EC2, where the network belongs to the instance: `run-task` neither
# needs `--network-configuration` nor accepts it, since ECS rejects that flag outright for a task
# definition that is not `awsvpc`. So the call simply does not carry one, and nothing here has to
# read a VPC layout to decide that.
#
# If a deployment ever DID use awsvpc, that is a change to THIS SCRIPT and not a flag to set: the
# subnets and security groups would have to be read from the service's `networkConfiguration` and
# passed through, and the launch-type fallback below would have to change with them. Written down
# so the assumption is a decision on the record rather than an omission somebody has to infer.
#
# ── THE UNPROVISIONED CASE, AND WHY IT HAS TWO ANSWERS ──────────────────────────────────────────
#
# Two things can be absent: the cluster variable, and the service itself (a deployment that has not
# happened yet). Both are answered differently depending on who is asking:
#
#   * on the SCHEDULE, it is announced as a warning and the job succeeds. An environment that has
#     never been deployed is not a reason to turn the nightly run red every night for nobody to act
#     on. The warning is loud, appears in the run summary, and says what is missing.
#   * on a `workflow_dispatch`, it FAILS. An operator dispatching this run is asking "is the wiring
#     correct", and a green run that did nothing answers the wrong question.
#
# `DISPATCHED` carries which one it is. Either way the run first prints everything it read — the
# `failures` array, the service's status and its placement — because a log read a night later is
# all an operator has, and "the service is not there" and "the cluster variable names the wrong
# cluster" have the same symptom and completely different fixes.
#
# Neither answer is available once the service is known to EXIST. From that point a call that fails
# is a failed call, not an absent resource, and it is an error on the schedule too.

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
# succeeds with an empty `services` array and the reason in `failures`. Only THAT answer may
# soft-skip. A failed CALL — expired credentials, a revoked policy, an ECS outage — is a different
# fact entirely: nothing was learned about the service, and treating ignorance as absence would let
# the schedule report success while the maintenance quietly never runs again. So a call failure
# fails the job, on the schedule too.
if ! service_json=$(
  aws ecs describe-services --cluster "$cluster" --services "$service" --output json
); then
  echo "::error::describe-services failed for ${service} on ${cluster} — an API error is not an absent service, and '${JOB}' cannot tell which it is. Fix the credential or the endpoint and re-run."
  exit 1
fi

service_arn=$(jq -r '.services[0].serviceArn // empty' <<<"$service_json")
service_status=$(jq -r '.services[0].status // empty' <<<"$service_json")
service_task_definition=$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")
launch_type=$(jq -r '.services[0].launchType // empty' <<<"$service_json")
strategy=$(jq -c '.services[0].capacityProviderStrategy // empty' <<<"$service_json")
placement_constraints=$(jq -c '.services[0].placementConstraints // empty' <<<"$service_json")
# `failures` is where `describe-services` puts the reason a name it was asked about produced no
# service — MISSING, or a cluster that does not hold it. It is the difference between "deploy the
# API first" and "the cluster variable names the wrong cluster", and it is not a secret: an ARN and
# a reason string.
failures=$(jq -c '.failures // []' <<<"$service_json")

# Everything that was read, in one block, on stdout. A run that declines has to say what it saw:
# an operator re-reading the log a night later cannot re-run the calls. Resource names, a status and
# a placement — nothing here is a credential or a secret value.
print_discovery() {
  echo "discovered for ${service} on cluster ${cluster}:"
  echo "  failures                 : ${failures}"
  echo "  service ARN              : ${service_arn:-<absent>}"
  echo "  service status           : ${service_status:-<absent>}"
  echo "  service taskDefinition   : ${service_task_definition:-<none>}"
  echo "  service launchType       : ${launch_type:-<none>}"
  echo "  capacityProviderStrategy : ${strategy:-<none>}"
  echo "  placementConstraints     : ${placement_constraints:-<none>}"
}

if [ -z "$service_arn" ]; then
  print_discovery
  not_provisioned "service missing (failures: ${failures}) — no service ${service} on cluster ${cluster}: deploy the ${TARGET_ENV} API first, so '${JOB}' did not run"
fi

# The service's own placement, verbatim: a service reports either `launchType` or, when it is on a
# capacity provider, a `capacityProviderStrategy` instead, and reusing whichever it has is what
# keeps the job on the same capacity as the API. EC2 is the fallback when it states neither, because
# EC2 is what this deployment runs.
run_args=()
if [ -n "$launch_type" ]; then
  run_args+=(--launch-type "$launch_type")
elif [ -n "$strategy" ] && [ "$strategy" != "[]" ]; then
  run_args+=(--capacity-provider-strategy "$strategy")
else
  run_args+=(--launch-type EC2)
fi

# The service's placement constraints go with its placement. A service pinned to an instance group —
# a `memberOf` attribute expression, `distinctInstance` — is pinned for a reason the job inherits
# along with everything else: the capacity it may land on, whatever that reason was. Dropping them
# would start the job on an instance the API is deliberately kept off.
if [ -n "$placement_constraints" ] && [ "$placement_constraints" != "[]" ]; then
  run_args+=(--placement-constraints "$placement_constraints")
fi

# Built with jq rather than string-concatenated: the container name is a value from elsewhere, and
# hand-quoting somebody else's value into a JSON document is how a deploy script starts executing
# it. `packages/api/dist/jobs.js` is the entry point tsup builds alongside migrate/seed/export;
# `--json` makes the task's log line one machine-readable object.
overrides=$(
  jq -nc --arg name "$container" --arg job "$JOB" \
    '{containerOverrides: [{name: $name, command: ["node", "packages/api/dist/jobs.js", $job, "--json"]}]}'
)

echo "starting ${JOB} on ${task_definition} in ${cluster} (${TARGET_ENV}), placed like ${service}"
task_arn=$(
  aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    "${run_args[@]}" \
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
  # One cause is worth naming rather than leaving to be rediscovered: in `bridge` mode with a FIXED
  # `hostPort`, the API service already reserves that port on every instance it is eligible for, and
  # a second task wanting the same port is unplaceable on all of them. The symptom is a placement
  # failure, not an application error, and it looks like an outage until somebody knows to read it
  # as one. The script cannot fix it — the fix is a dynamic host port (`hostPort: 0`) or spare
  # eligible capacity — so it points at it instead. Matched case-insensitively because the wording
  # of `stoppedReason` is AWS's and has changed before.
  reason_lower=$(printf '%s' "$reason" | tr '[:upper:]' '[:lower:]')
  case "$reason_lower" in
    *resource*|*port*)
      echo "::error::'${JOB}' looks like it could not be PLACED rather than having failed: the service ${service} may already reserve the port or the capacity this task needed. In bridge mode with a fixed hostPort, only one task per instance can hold the port — give the task definition a dynamic host port (hostPort: 0) or add eligible capacity. See packages/api/docs/jobs.md section 2."
      ;;
  esac
  exit 1
fi
