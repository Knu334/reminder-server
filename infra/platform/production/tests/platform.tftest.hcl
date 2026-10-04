# These plan assertions catch unsupported auth flows, longer-lived tokens,
# changed runtime keys/retention, and grants escaping each function's ceiling.
mock_provider "aws" {}

variables {
  account_id            = "123456789012"
  region                = "us-east-1"
  name_prefix           = "synthetic-reminder"
  chrome_origin         = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
  callback_url          = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback"
  logout_url            = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/logout"
  cognito_domain_prefix = "synthetic-reminder-login"
  api_role_arn          = "arn:aws:iam::123456789012:role/synthetic-reminder-production-api"
  cleanup_role_arn      = "arn:aws:iam::123456789012:role/synthetic-reminder-production-cleanup"
}

run "cognito_is_console_managed_public_code_client" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool.production.user_pool_tier == "ESSENTIALS" && aws_cognito_user_pool.production.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool.production.deletion_protection == "ACTIVE"
    error_message = "Only console-managed Essentials users belong in the protected production pool."
  }
  assert {
    condition     = !aws_cognito_user_pool_client.chrome.generate_secret && aws_cognito_user_pool_client.chrome.allowed_oauth_flows_user_pool_client && aws_cognito_user_pool_client.chrome.allowed_oauth_flows == toset(["code"]) && aws_cognito_user_pool_client.chrome.supported_identity_providers == toset(["COGNITO"]) && !contains(aws_cognito_user_pool_client.chrome.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH")
    error_message = "Chrome requires a public code client with Cognito only and no legacy refresh flow."
  }
  assert {
    condition     = aws_cognito_user_pool_client.chrome.callback_urls == toset(["https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback"]) && aws_cognito_user_pool_client.chrome.logout_urls == toset(["https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/logout"]) && aws_cognito_user_pool_domain.production.domain == "synthetic-reminder-login"
    error_message = "Full callback/logout URLs and the explicit domain must be preserved."
  }
  assert {
    condition     = aws_cognito_resource_server.api.identifier == "reminder-api" && toset([for s in aws_cognito_resource_server.api.scope : s.scope_name]) == toset(["read", "write"]) && aws_cognito_user_pool_client.chrome.allowed_oauth_scopes == toset(["openid", "reminder-api/read", "reminder-api/write"])
    error_message = "Hosted UI scopes must match Gateway and runtime identity verification."
  }
  assert {
    condition     = aws_cognito_user_pool_client.chrome.read_attributes == toset(["email"]) && aws_cognito_user_pool_client.chrome.write_attributes == toset(["email"])
    error_message = "Only the email attribute is needed by Hosted UI initial setup."
  }
}

run "token_units_and_rotation_are_exact" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool_client.chrome.access_token_validity == 5 && aws_cognito_user_pool_client.chrome.token_validity_units[0].access_token == "minutes" && aws_cognito_user_pool_client.chrome.id_token_validity == 5 && aws_cognito_user_pool_client.chrome.token_validity_units[0].id_token == "minutes" && aws_cognito_user_pool_client.chrome.refresh_token_validity == 30 && aws_cognito_user_pool_client.chrome.token_validity_units[0].refresh_token == "days"
    error_message = "Access/ID tokens must last five minutes and refresh tokens thirty days."
  }
  assert {
    condition     = aws_cognito_user_pool_client.chrome.refresh_token_rotation[0].feature == "ENABLED" && aws_cognito_user_pool_client.chrome.refresh_token_rotation[0].retry_grace_period_seconds == 10 && aws_cognito_user_pool_client.chrome.enable_token_revocation
    error_message = "Refresh token rotation requires ten-second grace and revocation."
  }
}

run "storage_keys_retention_and_roles_match_runtime" {
  command = plan
  assert {
    condition     = aws_dynamodb_table.runtime["reminders"].name == "synthetic-reminder-production-reminders" && aws_dynamodb_table.runtime["reminders"].hash_key == "ownerId" && aws_dynamodb_table.runtime["reminders"].range_key == "id" && aws_dynamodb_table.runtime["owner_state"].name == "synthetic-reminder-production-owner-state" && aws_dynamodb_table.runtime["owner_state"].hash_key == "pk" && aws_dynamodb_table.runtime["owner_state"].range_key == "sk" && aws_dynamodb_table.runtime["image_jobs"].name == "synthetic-reminder-production-image-jobs" && aws_dynamodb_table.runtime["image_jobs"].hash_key == "jobId" && aws_dynamodb_table.runtime["image_jobs"].range_key == null
    error_message = "The three table names and keys must match the runtime producers exactly."
  }
  assert {
    condition     = length(aws_dynamodb_table.runtime) == 3 && alltrue([for t in aws_dynamodb_table.runtime : t.billing_mode == "PAY_PER_REQUEST" && t.deletion_protection_enabled && t.point_in_time_recovery[0].enabled && t.point_in_time_recovery[0].recovery_period_in_days == 35]) && aws_dynamodb_table.runtime["owner_state"].ttl[0].enabled && aws_dynamodb_table.runtime["owner_state"].ttl[0].attribute_name == "expiresAt" && length(aws_dynamodb_table.runtime["image_jobs"].ttl) == 0 && length(aws_dynamodb_table.runtime["reminders"].ttl) == 0
    error_message = "Retain protected on-demand tables with PITR35 and only the owner-state rate TTL."
  }
  assert {
    condition     = length(aws_dynamodb_table.runtime["image_jobs"].global_secondary_index) == 1 && one(aws_dynamodb_table.runtime["image_jobs"].global_secondary_index).name == "cleanup_by_due" && one(aws_dynamodb_table.runtime["image_jobs"].global_secondary_index).projection_type == "KEYS_ONLY" && one(aws_dynamodb_table.runtime["image_jobs"].global_secondary_index).key_schema == tolist([{ attribute_name = "cleanupPartition", key_type = "HASH" }, { attribute_name = "cleanupSortKey", key_type = "RANGE" }]) && toset([for a in aws_dynamodb_table.runtime["image_jobs"].attribute : "${a.name}:${a.type}"]) == toset(["jobId:S", "cleanupPartition:S", "cleanupSortKey:S"])
    error_message = "The sparse cleanup index must project only its exact string keys."
  }
  assert {
    condition     = aws_s3_bucket.images.bucket == "synthetic-reminder-123456789012-us-east-1-images" && !aws_s3_bucket.images.force_destroy && aws_s3_bucket_versioning.images.versioning_configuration[0].status == "Enabled" && length(aws_s3_bucket_lifecycle_configuration.images.rule) == 1 && one(aws_s3_bucket_lifecycle_configuration.images.rule).status == "Enabled" && one(aws_s3_bucket_lifecycle_configuration.images.rule).noncurrent_version_expiration[0].noncurrent_days == 60 && length(one(aws_s3_bucket_lifecycle_configuration.images.rule).expiration) == 0
    error_message = "Image versions need noncurrent60 retention with no current-object expiration."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.images.block_public_acls && aws_s3_bucket_public_access_block.images.block_public_policy && aws_s3_bucket_public_access_block.images.ignore_public_acls && aws_s3_bucket_public_access_block.images.restrict_public_buckets && one(aws_s3_bucket_server_side_encryption_configuration.images.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "Image storage must be private and encrypted."
  }
  assert {
    condition     = one(aws_s3_bucket_cors_configuration.images.cors_rule).allowed_origins == toset(["chrome-extension://abcdefghijklmnopabcdefghijklmnop"]) && one(aws_s3_bucket_cors_configuration.images.cors_rule).allowed_methods == toset(["GET", "HEAD"])
    error_message = "CORS must allow only the exact extension origin and read methods."
  }
  assert {
    condition     = aws_cloudwatch_log_group.runtime["api"].name == "/aws/lambda/synthetic-reminder-production-api" && aws_cloudwatch_log_group.runtime["cleanup"].name == "/aws/lambda/synthetic-reminder-production-cleanup" && aws_cloudwatch_log_group.gateway.name == "/aws/apigateway/synthetic-reminder-production-api" && alltrue([for g in aws_cloudwatch_log_group.runtime : g.retention_in_days == 30]) && aws_cloudwatch_log_group.gateway.retention_in_days == 30
    error_message = "API, cleanup and Gateway logs must have exact shared names and thirty-day retention."
  }
  assert {
    condition     = aws_iam_role_policy.api.role == "synthetic-reminder-production-api" && aws_iam_role_policy.cleanup.role == "synthetic-reminder-production-cleanup" && output.api_role_arn == "arn:aws:iam::123456789012:role/synthetic-reminder-production-api" && output.cleanup_role_arn == "arn:aws:iam::123456789012:role/synthetic-reminder-production-cleanup"
    error_message = "Inline policies and outputs must reference bootstrap's existing roles."
  }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.api.policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "s3:ListBucket", "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "logs:CreateLogStream", "logs:PutLogEvents"]) && toset(flatten([for s in jsondecode(aws_iam_role_policy.cleanup.policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "s3:ListBucket", "s3:GetObject", "s3:DeleteObject", "logs:CreateLogStream", "logs:PutLogEvents", "cloudwatch:PutMetricData"])
    error_message = "Grant only supported runtime IAM actions; cleanup must not read/delete object versions or administer users."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.cleanup.policy).Statement : !contains(s.Action, "dynamodb:PutItem") && !contains(s.Action, "dynamodb:UpdateItem") || toset(s.Resource) == toset(["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"])]) && alltrue([for s in jsondecode(aws_iam_role_policy.cleanup.policy).Statement : !contains(s.Action, "dynamodb:Query") || toset(s.Resource) == toset(["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs/index/cleanup_by_due"])])
    error_message = "Cleanup can write only image jobs/checkpoint and query only the due index."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.api.policy).Statement : !contains(s.Action, "s3:GetObjectVersion") || toset(s.Resource) == toset(["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"])]) && alltrue([for s in jsondecode(aws_iam_role_policy.cleanup.policy).Statement : !contains(s.Action, "cloudwatch:PutMetricData") || s.Condition.StringEquals["cloudwatch:namespace"] == "ReminderServer" && s.Condition.StringEquals["aws:RequestedRegion"] == "us-east-1"])
    error_message = "Pinned browser reads must stay inside images and cleanup metrics inside the namespace/region."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.api.policy).Statement : s.Effect == "Allow" && alltrue([for action in s.Action : toset(s.Resource) == toset(lookup({
      "dynamodb:GetItem"     = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:PutItem"     = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:UpdateItem"  = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:Query"       = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders"]
      "s3:ListBucket"        = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images"]
      "s3:GetObject"         = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"]
      "s3:GetObjectVersion"  = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"]
      "s3:PutObject"         = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"]
      "logs:CreateLogStream" = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*"]
      "logs:PutLogEvents"    = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*"]
    }, action, []))])])
    error_message = "Every API action must fit the exact table/object/log inventory from bootstrap."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.cleanup.policy).Statement : s.Effect == "Allow" && alltrue([for action in s.Action : toset(s.Resource) == toset(lookup({
      "dynamodb:GetItem"         = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:PutItem"         = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:UpdateItem"      = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"]
      "dynamodb:Query"           = ["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs/index/cleanup_by_due"]
      "s3:ListBucket"            = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images"]
      "s3:GetObject"             = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"]
      "s3:DeleteObject"          = ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"]
      "logs:CreateLogStream"     = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*"]
      "logs:PutLogEvents"        = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*"]
      "cloudwatch:PutMetricData" = ["*"]
    }, action, []))])])
    error_message = "Cleanup must read the owner gate only, write jobs only and log only as cleanup."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.images.policy).Statement : s.Effect == "Deny" && s.Principal == "*" && s.Condition.Bool["aws:SecureTransport"] == "false" && toset(s.Resource) == toset(["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images", "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/*"])]) && length(jsondecode(aws_s3_bucket_policy.images.policy).Statement) == 1
    error_message = "Image bucket policy must deny insecure transport and grant no public access."
  }
}

run "reject_wildcard_origin" {
  command = plan
  variables { chrome_origin = "*" }
  expect_failures = [var.chrome_origin]
}
run "reject_incomplete_callback" {
  command = plan
  variables { callback_url = "https://*.chromiumapp.org" }
  expect_failures = [var.callback_url]
}
run "reject_fragment_logout" {
  command = plan
  variables { logout_url = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/logout#fragment" }
  expect_failures = [var.logout_url]
}
run "reject_wrong_bootstrap_role" {
  command = plan
  variables { cleanup_role_arn = "arn:aws:iam::123456789012:role/synthetic-reminder-production-api" }
  expect_failures = [var.cleanup_role_arn]
}

run "reject_reserved_domain" {
  command = plan
  variables { cognito_domain_prefix = "aws-login" }
  expect_failures = [var.cognito_domain_prefix]
}
run "reject_other_partition" {
  command = plan
  variables { region = "cn-north-1" }
  expect_failures = [var.region]
}
run "reject_invalid_account" {
  command = plan
  variables {
    account_id       = "1234"
    api_role_arn     = "arn:aws:iam::1234:role/synthetic-reminder-production-api"
    cleanup_role_arn = "arn:aws:iam::1234:role/synthetic-reminder-production-cleanup"
  }
  expect_failures = [var.account_id]
}
