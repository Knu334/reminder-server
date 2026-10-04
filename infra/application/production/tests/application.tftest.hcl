# Cloud calls are mocked; resource arguments, lifecycle guards and policies are real.
# Mutations caught: mutable/different ZIP, open v2 route, broad invoke, active
# unpublished schedule, wrong metric dimensions/retention and API reseeding.
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_lambda_function" {
    defaults = {
      code_sha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      version     = "7"
    }
  }
  mock_resource "aws_apigatewayv2_authorizer" {
    defaults = { id = "mock-jwt" }
  }
  mock_resource "aws_apigatewayv2_integration" {
    defaults = { id = "mock-integration" }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      id            = "abc123def4"
      api_endpoint  = "https://abc123def4.execute-api.us-east-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:abc123def4"
    }
  }
}
override_resource {
  override_during = plan
  target          = aws_lambda_alias.api
  values = {
    arn        = "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-api:production"
    invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-api:production/invocations"
  }
}
override_resource {
  override_during = plan
  target          = aws_lambda_alias.cleanup
  values          = { arn = "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup:production" }
}
variables {
  account_id            = "123456789012"
  region                = "us-east-1"
  name_prefix           = "synthetic-reminder"
  chrome_origin         = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
  production_api_id     = "abc123def4"
  api_role_arn          = "arn:aws:iam::123456789012:role/synthetic-reminder-production-api"
  cleanup_role_arn      = "arn:aws:iam::123456789012:role/synthetic-reminder-production-cleanup"
  scheduler_role_arn    = "arn:aws:iam::123456789012:role/synthetic-reminder-production-scheduler"
  reminders_table       = "synthetic-reminder-production-reminders"
  owner_state_table     = "synthetic-reminder-production-owner-state"
  image_jobs_table      = "synthetic-reminder-production-image-jobs"
  images_bucket         = "synthetic-reminder-123456789012-us-east-1-images"
  api_log_group         = "/aws/lambda/synthetic-reminder-production-api"
  cleanup_log_group     = "/aws/lambda/synthetic-reminder-production-cleanup"
  gateway_log_group     = "/aws/apigateway/synthetic-reminder-production-api"
  cognito_issuer        = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic"
  cognito_client_id     = "syntheticclient123"
  cognito_auth_base_url = "https://synthetic-reminder-login.auth.us-east-1.amazoncognito.com"
  artifact = {
    bucket        = "synthetic-reminder-123456789012-us-east-1-artifacts"
    key           = "releases/0000000000000000000000000000000000000000000000000000000000000000/reminder-server.zip"
    version_id    = "synthetic-immutable-version"
    sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  }
}

run "both_functions_use_same_versioned_zip" {
  command = plan
  assert {
    condition     = aws_lambda_function.api.code_sha256 == aws_lambda_function.cleanup.code_sha256 && aws_lambda_function.api.code_sha256 == var.artifact.sha256_base64 && aws_lambda_function.api.s3_object_version == aws_lambda_function.cleanup.s3_object_version && aws_lambda_function.api.s3_object_version == "synthetic-immutable-version" && aws_lambda_function.api.s3_bucket == var.artifact.bucket && aws_lambda_function.cleanup.s3_bucket == var.artifact.bucket && aws_lambda_function.api.s3_key == var.artifact.key && aws_lambda_function.cleanup.s3_key == var.artifact.key && aws_lambda_function.api.source_code_hash == var.artifact.sha256_base64 && aws_lambda_function.cleanup.source_code_hash == var.artifact.sha256_base64
    error_message = "Both handlers must publish the selected immutable ZIP and verify AWS CodeSha256."
  }
  assert {
    condition     = aws_lambda_function.api.function_name == "synthetic-reminder-production-api" && aws_lambda_function.cleanup.function_name == "synthetic-reminder-production-cleanup" && aws_lambda_function.api.handler == "dist/api.handler" && aws_lambda_function.cleanup.handler == "dist/cleanup.handler" && alltrue([for f in [aws_lambda_function.api, aws_lambda_function.cleanup] : f.runtime == "nodejs24.x" && f.architectures == tolist(["x86_64"]) && f.package_type == "Zip" && f.publish && f.memory_size == 512 && f.filename == null && f.image_uri == null && length(f.dead_letter_config) == 0])
    error_message = "Only two node24 AMD64 ZIP handlers may be deployed with 512 MiB and no DLQ."
  }
  assert {
    condition     = aws_lambda_function.api.timeout == 10 && aws_lambda_function.api.reserved_concurrent_executions == 10 && aws_lambda_function.cleanup.timeout == 660 && aws_lambda_function.cleanup.reserved_concurrent_executions == 1 && aws_lambda_function.api.role == var.api_role_arn && aws_lambda_function.cleanup.role == var.cleanup_role_arn
    error_message = "Function budgets and existing bootstrap roles must match the approved ceilings."
  }
  assert {
    condition     = alltrue([for a in [aws_lambda_alias.api, aws_lambda_alias.cleanup] : a.name == "production" && a.function_version == "7" && length(a.routing_config) == 0]) && output.api_version == "7" && output.cleanup_version == "7" && output.release_sha256_base64 == var.artifact.sha256_base64
    error_message = "Production aliases must point to published versions with one verified release digest."
  }
  assert {
    condition     = alltrue([for f in [aws_lambda_function.api, aws_lambda_function.cleanup] : f.environment[0].variables == tomap({ REMINDERS_TABLE = "synthetic-reminder-production-reminders", OWNER_STATE_TABLE = "synthetic-reminder-production-owner-state", IMAGE_JOBS_TABLE = "synthetic-reminder-production-image-jobs", IMAGES_BUCKET = "synthetic-reminder-123456789012-us-east-1-images", EXPECTED_API_ID = "abc123def4", EXPECTED_API_STAGE = "$default", COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic", COGNITO_CLIENT_ID = "syntheticclient123" })]) && aws_lambda_function.api.logging_config[0].log_group == var.api_log_group && aws_lambda_function.cleanup.logging_config[0].log_group == var.cleanup_log_group
    error_message = "Both lazy handlers need exact runtime config; AWS_REGION is Lambda managed."
  }
}

run "jwt_routes_and_cors_are_exact" {
  command = plan
  assert {
    condition     = aws_apigatewayv2_api.production.name == "synthetic-reminder-production-api" && aws_apigatewayv2_api.production.protocol_type == "HTTP" && !aws_apigatewayv2_api.production.disable_execute_api_endpoint && aws_apigatewayv2_stage.production.name == "$default" && aws_apigatewayv2_stage.production.auto_deploy && !aws_apigatewayv2_stage.production.default_route_settings[0].detailed_metrics_enabled && aws_apigatewayv2_stage.production.default_route_settings[0].throttling_rate_limit == 20 && aws_apigatewayv2_stage.production.default_route_settings[0].throttling_burst_limit == 40
    error_message = "The protected HTTP API uses an enabled endpoint and throttled default stage without route metrics."
  }
  assert {
    condition     = aws_apigatewayv2_integration.api.integration_type == "AWS_PROXY" && aws_apigatewayv2_integration.api.payload_format_version == "2.0" && aws_apigatewayv2_integration.api.timeout_milliseconds == 15000 && aws_apigatewayv2_integration.api.integration_uri == aws_lambda_alias.api.invoke_arn && aws_apigatewayv2_stage.production.access_log_settings[0].destination_arn == "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/synthetic-reminder-production-api"
    error_message = "Gateway invokes the production alias with v2 events and writes only the platform log group."
  }
  assert {
    condition     = aws_lambda_permission.gateway.action == "lambda:InvokeFunction" && aws_lambda_permission.gateway.principal == "apigateway.amazonaws.com" && aws_lambda_permission.gateway.qualifier == "production" && aws_lambda_permission.gateway.function_name == "synthetic-reminder-production-api" && aws_lambda_permission.gateway.source_account == "123456789012" && aws_lambda_permission.gateway.source_arn == "arn:aws:execute-api:us-east-1:123456789012:abc123def4/$default/*/*"
    error_message = "Gateway invocation must be limited to this API/default stage and API production alias."
  }
  assert {
    condition     = aws_apigatewayv2_authorizer.cognito.authorizer_type == "JWT" && aws_apigatewayv2_authorizer.cognito.identity_sources == toset(["$request.header.Authorization"]) && aws_apigatewayv2_authorizer.cognito.jwt_configuration[0].audience == toset(["syntheticclient123"]) && aws_apigatewayv2_authorizer.cognito.jwt_configuration[0].issuer == var.cognito_issuer
    error_message = "JWT authorizer must match the platform issuer and public client ID."
  }
  assert {
    condition     = toset(keys(aws_apigatewayv2_route.api)) == toset(["GET /healthz", "GET /readyz", "POST /reminders", "PUT /reminders", "GET /v2/reminders", "POST /v2/reminders", "GET /v2/reminders/{id}", "PATCH /v2/reminders/{id}", "DELETE /v2/reminders/{id}", "GET /v2/reminders/{id}/thumbnail-url"]) && alltrue([for key, r in aws_apigatewayv2_route.api : r.route_key == key && r.target == "integrations/${aws_apigatewayv2_integration.api.id}" && (strcontains(key, "/v2/") ? r.authorization_type == "JWT" && r.authorizer_id == aws_apigatewayv2_authorizer.cognito.id && r.authorization_scopes == toset([startswith(key, "GET ") ? "reminder-api/read" : "reminder-api/write"]) : r.authorization_type == "NONE" && r.authorizer_id == null && length(r.authorization_scopes) == 0)])
    error_message = "Only v2 routes use JWT/read-write scopes; health, ready and legacy410 are public, OPTIONS is Gateway CORS."
  }
  assert {
    condition     = aws_apigatewayv2_api.production.cors_configuration[0].allow_origins == toset([var.chrome_origin]) && aws_apigatewayv2_api.production.cors_configuration[0].allow_methods == toset(["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"]) && aws_apigatewayv2_api.production.cors_configuration[0].allow_headers == toset(["authorization", "content-type", "if-match"]) && aws_apigatewayv2_api.production.cors_configuration[0].expose_headers == toset(["ETag", "Location", "X-Request-Id", "Retry-After"]) && !aws_apigatewayv2_api.production.cors_configuration[0].allow_credentials
    error_message = "CORS needs exact origin and supported request/response headers without credentials or wildcard."
  }
}

run "schedule_is_disabled_until_publication" {
  command = plan
  assert {
    condition     = !output.scheduler_enabled && aws_scheduler_schedule.cleanup.state == "DISABLED" && aws_scheduler_schedule_group.cleanup.name == "synthetic-reminder-production-cleanup" && aws_scheduler_schedule.cleanup.name == "synthetic-reminder-production-cleanup" && aws_scheduler_schedule.cleanup.group_name == "synthetic-reminder-production-cleanup" && aws_scheduler_schedule.cleanup.schedule_expression == "cron(0 3 * * ? *)" && aws_scheduler_schedule.cleanup.schedule_expression_timezone == "UTC" && aws_scheduler_schedule.cleanup.flexible_time_window[0].mode == "OFF"
    error_message = "Cleanup is initially disabled in the exact bootstrap-trusted dedicated daily UTC group."
  }
  assert {
    condition     = aws_scheduler_schedule.cleanup.target[0].arn == aws_lambda_alias.cleanup.arn && aws_scheduler_schedule.cleanup.target[0].role_arn == var.scheduler_role_arn && aws_scheduler_schedule.cleanup.target[0].retry_policy[0].maximum_retry_attempts == 2 && aws_scheduler_schedule.cleanup.target[0].retry_policy[0].maximum_event_age_in_seconds == 3600 && length(aws_scheduler_schedule.cleanup.target[0].dead_letter_config) == 0 && aws_lambda_function_event_invoke_config.cleanup.qualifier == "production" && aws_lambda_function_event_invoke_config.cleanup.maximum_retry_attempts == 2 && aws_lambda_function_event_invoke_config.cleanup.maximum_event_age_in_seconds == 3600 && length(aws_lambda_function_event_invoke_config.cleanup.destination_config) == 0
    error_message = "Scheduler delivery and Lambda asynchronous retry budgets are separately 2/3600, alias only, with no DLQ."
  }
  assert {
    condition     = aws_iam_role_policy.scheduler.role == "synthetic-reminder-production-scheduler" && jsondecode(aws_iam_role_policy.scheduler.policy).Statement == [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup:production"] }]
    error_message = "Application can add only the production cleanup Invoke grant to the existing Scheduler role."
  }
}

run "nine_alarms_have_correct_missing_data_policy" {
  command = plan
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.production) == 9 && toset(keys(aws_cloudwatch_metric_alarm.production)) == toset(["gateway_5xx", "api_errors", "api_throttles", "api_duration", "cleanup_errors", "cleanup_async_dropped", "cleanup_incomplete", "scheduler_dropped", "cleanup_heartbeat"])
    error_message = "Production must have exactly the nine approved alarms."
  }
  assert {
    condition     = alltrue([for k in ["gateway_5xx", "api_errors", "api_throttles", "cleanup_errors", "cleanup_async_dropped", "scheduler_dropped"] : aws_cloudwatch_metric_alarm.production[k].period == 300 && aws_cloudwatch_metric_alarm.production[k].evaluation_periods == 1 && aws_cloudwatch_metric_alarm.production[k].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.production[k].threshold == 1 && aws_cloudwatch_metric_alarm.production[k].statistic == "Sum" && aws_cloudwatch_metric_alarm.production[k].treat_missing_data == "notBreaching"])
    error_message = "Error alarms use one five-minute Sum>=1 period with missing data not breaching."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.production["api_duration"].metric_name == "Duration" && aws_cloudwatch_metric_alarm.production["api_duration"].period == 300 && aws_cloudwatch_metric_alarm.production["api_duration"].evaluation_periods == 2 && aws_cloudwatch_metric_alarm.production["api_duration"].threshold == 2000 && aws_cloudwatch_metric_alarm.production["api_duration"].comparison_operator == "GreaterThanThreshold" && aws_cloudwatch_metric_alarm.production["api_duration"].extended_statistic == "p95" && aws_cloudwatch_metric_alarm.production["api_duration"].evaluate_low_sample_count_percentiles == "ignore" && aws_cloudwatch_metric_alarm.production["api_duration"].treat_missing_data == "notBreaching"
    error_message = "API duration requires two five-minute p95>2000ms periods and ignores insufficient samples."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.production["gateway_5xx"].metric_name == "5xx" && aws_cloudwatch_metric_alarm.production["gateway_5xx"].namespace == "AWS/ApiGateway" && aws_cloudwatch_metric_alarm.production["gateway_5xx"].dimensions == tomap({ ApiId = "abc123def4" }) && alltrue([for k in ["api_errors", "api_throttles", "api_duration"] : aws_cloudwatch_metric_alarm.production[k].namespace == "AWS/Lambda" && aws_cloudwatch_metric_alarm.production[k].dimensions == tomap({ FunctionName = "synthetic-reminder-production-api" })]) && aws_cloudwatch_metric_alarm.production["api_errors"].metric_name == "Errors" && aws_cloudwatch_metric_alarm.production["api_throttles"].metric_name == "Throttles" && alltrue([for k in ["cleanup_errors", "cleanup_async_dropped"] : aws_cloudwatch_metric_alarm.production[k].namespace == "AWS/Lambda" && aws_cloudwatch_metric_alarm.production[k].dimensions == tomap({ FunctionName = "synthetic-reminder-production-cleanup" })]) && aws_cloudwatch_metric_alarm.production["cleanup_errors"].metric_name == "Errors" && aws_cloudwatch_metric_alarm.production["cleanup_async_dropped"].metric_name == "AsyncEventsDropped" && aws_cloudwatch_metric_alarm.production["scheduler_dropped"].namespace == "AWS/Scheduler" && aws_cloudwatch_metric_alarm.production["scheduler_dropped"].metric_name == "InvocationDroppedCount" && aws_cloudwatch_metric_alarm.production["scheduler_dropped"].dimensions == tomap({ ScheduleGroup = "synthetic-reminder-production-cleanup" })
    error_message = "Each service alarm must monitor its exact production function/API/group metric."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].namespace == "ReminderServer" && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].metric_name == "CleanupIncomplete" && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].dimensions == tomap({ Environment = "production" }) && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].period == 3600 && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].statistic == "Maximum" && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].threshold == 1 && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.production["cleanup_incomplete"].treat_missing_data == "notBreaching" && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].namespace == "ReminderServer" && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].metric_name == "CleanupHeartbeat" && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].dimensions == tomap({ Environment = "production" }) && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].period == 86400 && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].statistic == "Sum" && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].threshold == 1 && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].comparison_operator == "LessThanThreshold" && !aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].actions_enabled && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].treat_missing_data == "notBreaching" && alltrue([for a in aws_cloudwatch_metric_alarm.production : length(coalesce(a.alarm_actions, [])) == 0 && length(coalesce(a.ok_actions, [])) == 0 && length(coalesce(a.insufficient_data_actions, [])) == 0])
    error_message = "Custom metrics match producers and heartbeat missing-data/actions remain inactive before publication; no SNS is added."
  }
}
run "publication_activates_schedule_and_heartbeat_together" {
  command = plan
  variables { scheduler_enabled = true }
  assert {
    condition     = aws_scheduler_schedule.cleanup.state == "ENABLED" && output.scheduler_enabled && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].actions_enabled && aws_cloudwatch_metric_alarm.production["cleanup_heartbeat"].treat_missing_data == "breaching"
    error_message = "Published cleanup must activate its missing-heartbeat alarm in the same change."
  }
}
run "normal_release_rejects_absent_api_id" {
  command = plan
  variables { production_api_id = null }
  expect_failures = [var.production_api_id]
}
run "normal_release_rejects_wrong_api_id" {
  command = plan
  variables { production_api_id = "other12345" }
  expect_failures = [aws_apigatewayv2_api.production]
}
run "operator_seed_targets_only_application_owned_api" {
  command = plan
  variables {
    operator_api_seed = true
    production_api_id = null
  }
  plan_options { target = [aws_apigatewayv2_api.production] }
  assert {
    condition     = output.api_id == "abc123def4" && aws_apigatewayv2_api.production.name == "synthetic-reminder-production-api"
    error_message = "Exceptional operator seed uses this exact resource and yields the bootstrap API ID handoff."
  }
}
run "operator_seed_rejects_full_root_release" {
  command = plan
  variables {
    operator_api_seed = true
    production_api_id = null
  }
  expect_failures = [aws_lambda_function.api, aws_lambda_function.cleanup]
}
run "operator_seed_rejects_known_id" {
  command = plan
  variables { operator_api_seed = true }
  expect_failures = [var.production_api_id]
}
run "operator_seed_rejects_enabled_schedule" {
  command = plan
  variables {
    operator_api_seed = true
    production_api_id = null
    scheduler_enabled = true
  }
  expect_failures = [var.operator_api_seed]
}
run "code_digest_mismatch_fails_closed" {
  command = plan
  override_resource {
    target          = aws_lambda_function.cleanup
    override_during = plan
    values          = { code_sha256 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=" }
  }
  expect_failures = [aws_lambda_function.cleanup]
}
run "runtime_overrides_preserve_numeric_strings_and_ip_json" {
  command = plan
  variables {
    allowed_source_ips = ["192.0.2.1", "2001:db8::1"]
    runtime_limits     = { MAX_JSON_BYTES = 100, MAX_THUMBNAIL_BYTES = 2000000, MAX_OWNER_ITEMS = 5, MAX_OWNER_IMAGE_BYTES = 200000000, OWNER_REQUESTS_PER_MINUTE = 20 }
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.MAX_JSON_BYTES == "100" && aws_lambda_function.api.environment[0].variables.MAX_THUMBNAIL_BYTES == "2000000" && aws_lambda_function.api.environment[0].variables.MAX_OWNER_ITEMS == "5" && aws_lambda_function.api.environment[0].variables.MAX_OWNER_IMAGE_BYTES == "200000000" && aws_lambda_function.api.environment[0].variables.OWNER_REQUESTS_PER_MINUTE == "20" && jsondecode(aws_lambda_function.api.environment[0].variables.ALLOWED_SOURCE_IPS) == ["192.0.2.1", "2001:db8::1"]
    error_message = "Both lower/higher safe integer overrides and literal IP JSON must match loadConfig without coercion."
  }
}
run "reject_wildcard_origin" {
  command = plan
  variables { chrome_origin = "*" }
  expect_failures = [var.chrome_origin]
}
run "reject_wrong_role" {
  command = plan
  variables { scheduler_role_arn = "arn:aws:iam::123456789012:role/foreign" }
  expect_failures = [var.scheduler_role_arn]
}
run "reject_mutable_artifact" {
  command = plan
  variables {
    artifact = { bucket = "synthetic-reminder-123456789012-us-east-1-artifacts", key = "latest.zip", version_id = "null", sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }
  expect_failures = [var.artifact]
}
run "reject_fractional_runtime_limit" {
  command = plan
  variables { runtime_limits = { MAX_JSON_BYTES = 1.5 } }
  expect_failures = [var.runtime_limits]
}
run "reject_host_or_cidr_source_ip" {
  command = plan
  variables { allowed_source_ips = ["example.invalid", "192.0.2.0/24"] }
  expect_failures = [var.allowed_source_ips]
}
run "reject_invalid_ipv4_with_leading_zeros" {
  command = plan
  variables { allowed_source_ips = ["192.000.2.1"] }
  expect_failures = [var.allowed_source_ips]
}
run "reject_wrong_platform_table" {
  command = plan
  variables { image_jobs_table = "foreign-jobs" }
  expect_failures = [var.image_jobs_table]
}
run "reject_wrong_artifact_bucket" {
  command = plan
  variables {
    artifact = { bucket = "foreign-artifacts", key = "releases/0000000000000000000000000000000000000000000000000000000000000000/reminder-server.zip", version_id = "synthetic-version", sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }
  expect_failures = [var.artifact]
}
run "reject_unsupported_runtime_environment" {
  command = plan
  variables { runtime_limits = { AWS_REGION = 1 } }
  expect_failures = [var.runtime_limits]
}
run "reject_null_runtime_limit" {
  command = plan
  variables { runtime_limits = { MAX_OWNER_ITEMS = null } }
  expect_failures = [var.runtime_limits]
}
run "reject_zero_runtime_limit" {
  command = plan
  variables { runtime_limits = { MAX_OWNER_ITEMS = 0 } }
  expect_failures = [var.runtime_limits]
}
run "reject_unsafe_runtime_limit" {
  command = plan
  variables { runtime_limits = { MAX_OWNER_ITEMS = 9007199254740992 } }
  expect_failures = [var.runtime_limits]
}
