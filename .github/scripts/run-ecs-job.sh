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
# An awsvpc task needs a network configuration that `describe-task-definition` does not carry — it
# belongs to the SERVICE. Asking an operator to restate it in repository variables would be asking
# them to keep a copy of the VPC layout in sync by hand, and the failure mode of a stale copy is a
# task that starts in the wrong subnet and cannot reach the database. So the service is read at run
# time and its own network configuration and launch type are reused verbatim: the job lands exactly
# where the API lands, by construction.
#
# ── NOT EVERY DEPLOYMENT IS awsvpc, AND THAT IS NOT A FAULT ─────────────────────────────────────
#
# `awsvpcConfiguration` exists only when the task definition's `networkMode` is `awsvpc`. A service
# whose tasks use `bridge` or `host` — the ordinary shape of an EC2 launch type — has no network
# configuration to read, and passing `--network-configuration` for one is REJECTED by ECS. So the
# task definition is described as well, and its `networkMode` decides the shape of the `run-task`
# call: awsvpc reuses the service's configuration, anything else omits the flag entirely and keeps
# only the placement. `describe-task-definition` costs no new permission — the deploy workflow for
# this environment already calls it on the same family with the same credential.
#
# Only ONE combination is genuinely unprovisioned: an `awsvpc` task definition whose service states
# no network configuration. That is a service that cannot have been deployed, not a service of a
# different shape.
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
# `DISPATCHED` carries which one it is. Either way the run first prints everything it read — the
# `failures` array, the service's status and placement, the task definition's network mode — and
# the message names which case it actually is, because "the service is not there" and "the service
# is there and is shaped differently" have the same symptom and completely different fixes.
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
network=$(jq -c '.services[0].networkConfiguration.awsvpcConfiguration // empty' <<<"$service_json")
# `failures` is where `describe-services` puts the reason a name it was asked about produced no
# service — MISSING, or a cluster that does not hold it. It is the difference between "deploy the
# API first" and "the cluster variable names the wrong cluster", and it is not a secret: an ARN and
# a reason string.
failures=$(jq -c '.failures // []' <<<"$service_json")

# The task definition, described for its `networkMode`. This is not only diagnostic: it decides
# whether the `run-task` call may carry a `--network-configuration` at all. It is read from the
# FAMILY this script will actually run rather than from the revision the service happens to be on,
# so what is inspected is what starts. Whether the CALL succeeded is tracked separately from what it
# returned, because the two are answered differently below: an absent service may soft-skip, an
# unreadable task definition may not.
task_definition_read=false
network_mode=""
requires_compatibilities=""
if task_definition_json=$(aws ecs describe-task-definition --task-definition "$task_definition" --output json); then
  task_definition_read=true
  network_mode=$(jq -r '.taskDefinition.networkMode // empty' <<<"$task_definition_json")
  requires_compatibilities=$(jq -c '.taskDefinition.requiresCompatibilities // []' <<<"$task_definition_json")
fi

# Everything that was read, in one block, on stdout. A run that declines has to say what it saw:
# the two failure shapes are indistinguishable from the outside, and an operator re-reading the log
# a night later cannot re-run the calls. Resource names, a status, a network mode — nothing here is
# a credential or a secret value.
print_discovery() {
  echo "discovered for ${service} on cluster ${cluster}:"
  echo "  failures                 : ${failures}"
  echo "  service status           : ${service_status:-<absent>}"
  echo "  service launchType       : ${launch_type:-<none>}"
  echo "  capacityProviderStrategy : ${strategy:-<none>}"
  echo "  placementConstraints     : ${placement_constraints:-<none>}"
  echo "  service taskDefinition   : ${service_task_definition:-<none>}"
  echo "  ${task_definition} networkMode            : ${network_mode:-<could not describe>}"
  echo "  ${task_definition} requiresCompatibilities: ${requires_compatibilities:-<could not describe>}"
}

if [ -z "$service_arn" ]; then
  print_discovery
  not_provisioned "service missing (failures: ${failures}) — no service ${service} on cluster ${cluster}: deploy the ${TARGET_ENV} API first, so '${JOB}' did not run"
fi

# The service EXISTS, so its task definition is not an absent resource — it is one this run failed
# to read. That is the same fact `describe-services` failing would have been, and it gets the same
# answer: an error, on the schedule too. Soft-skipping here would let a permissions gap or an API
# blip report a green maintenance run every night, which is the exact failure this script's
# `describe-services` guard already refuses to allow.
if [ "$task_definition_read" != "true" ]; then
  print_discovery
  echo "::error::describe-task-definition failed for ${task_definition} while service ${service} on ${cluster} is present (status=${service_status:-unknown}) — the service exists, so this is a failed CALL and not an absent resource, and '${JOB}' cannot be placed without knowing its network mode. Fix the credential or the family name and re-run."
  exit 1
fi

if [ -z "$network" ]; then
  if [ "$network_mode" = "awsvpc" ]; then
    # The one genuinely unprovisioned shape: an awsvpc task definition whose service states no
    # network configuration. A running awsvpc service always has one.
    print_discovery
    not_provisioned "service ${service} on cluster ${cluster} is present (status=${service_status:-unknown}) but states no awsvpc network configuration (networkMode=awsvpc): deploy the ${TARGET_ENV} API first, so '${JOB}' did not run"
  fi
  # Anything else — bridge, host, none — is a service of a different, entirely valid shape. It has
  # no network configuration to reuse because there is none to have.
  echo "service present but not awsvpc (networkMode=${network_mode:-unset}): starting ${JOB} without a network configuration"
fi

# One decision, made once, and `run-task` is validated against the FAMILY's network mode rather than
# against what the service happens to report — a service still on an older revision can report an
# awsvpc configuration for a family that is no longer awsvpc, and sending the flag anyway is the
# rejection this whole change exists to avoid. `networkMode` absent from a description that
# otherwise succeeded is the one case the service still decides: a configuration it states is then
# the only evidence there is, and it is good evidence.
use_awsvpc=false
if [ -n "$network" ] && { [ "$network_mode" = "awsvpc" ] || [ -z "$network_mode" ]; }; then
  use_awsvpc=true
fi

# The service's own placement, verbatim: a Fargate service reports `launchType`, one on a capacity
# provider reports a strategy instead, and reusing whichever it has is what keeps the job on the
# same capacity as the API. The fallback applies only when the service states neither, and follows
# the network mode: FARGATE cannot run a bridge/host task definition, and EC2 is the only launch
# type that can.
run_args=()
if [ -n "$launch_type" ]; then
  run_args+=(--launch-type "$launch_type")
elif [ -n "$strategy" ] && [ "$strategy" != "[]" ]; then
  run_args+=(--capacity-provider-strategy "$strategy")
elif [ "$use_awsvpc" = "true" ]; then
  run_args+=(--launch-type FARGATE)
else
  run_args+=(--launch-type EC2)
fi

# The service's placement constraints go with its placement. A service pinned to an instance group —
# a `memberOf` attribute expression, `distinctInstance` — is pinned for a reason the job inherits
# with everything else: the capacity it may land on, whatever that reason was. Dropping them would
# start the job on an instance the API is deliberately kept off.
#
# Fargate does not accept them, and cannot have them either — `placementConstraints` on a Fargate
# service is rejected at creation — so a service that STATES any is by construction an EC2 one, and
# the launch-type guard is belt to that braces: it keeps the flag off the one path that would refuse
# it even if AWS ever loosened the first rule.
if [ -n "$placement_constraints" ] && [ "$placement_constraints" != "[]" ] && [ "$launch_type" != "FARGATE" ]; then
  run_args+=(--placement-constraints "$placement_constraints")
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

# Only an awsvpc task definition may be given one. ECS rejects the flag outright for bridge and
# host, so it is appended to the argument list rather than passed unconditionally with an empty
# value — there is no "no network configuration" value to send.
if [ "$use_awsvpc" = "true" ]; then
  run_args+=(--network-configuration "$(jq -nc --argjson vpc "$network" '{awsvpcConfiguration: $vpc}')")
fi

echo "starting ${JOB} on ${task_definition} in ${cluster} (${TARGET_ENV}), placed like ${service} (networkMode=${network_mode:-unknown})"
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
  # One cause is worth naming rather than leaving to be rediscovered: on `host`, or on `bridge` with
  # a FIXED `hostPort`, the API service already reserves that port on every instance it is eligible
  # for, and a second task wanting the same port is unplaceable on all of them. The symptom is a
  # placement failure, not an application error, and it looks like an outage until somebody knows
  # to read it as one. The script cannot fix it — the fix is a dynamic host port (`hostPort: 0`) or
  # spare eligible capacity — so it points at it instead. Matched case-insensitively because the
  # wording of `stoppedReason` is AWS's and has changed before.
  reason_lower=$(printf '%s' "$reason" | tr '[:upper:]' '[:lower:]')
  case "$reason_lower" in
    *resource*|*port*)
      echo "::error::'${JOB}' looks like it could not be PLACED rather than having failed: the service ${service} may already reserve the port or the capacity this task needed. On networkMode=host, or bridge with a fixed hostPort, only one task per instance can hold the port — give the task definition a dynamic host port (hostPort: 0) or add eligible capacity. See packages/api/docs/jobs.md section 2."
      ;;
  esac
  exit 1
fi
