# Mutations caught: public/unversioned storage, broad OIDC trust, artifact deletion,
# state writes by plan, data/user permissions, and unrestricted PassRole.
mock_provider "aws" {}

variables {
  account_id         = "123456789012"
  region             = "us-east-1"
  repository         = "synthetic/reminder-server"
  github_environment = "production"
  oidc_subjects = {
    artifact = "repo:synthetic/reminder-server:environment:production"
    plan     = "repo:synthetic/reminder-server:environment:production"
    apply    = "repo:synthetic/reminder-server:environment:production"
  }
  name_prefix = "synthetic-reminder"
}

run "private_versioned_buckets" {
  command = plan
  assert {
    condition     = aws_s3_bucket.artifacts.force_destroy == false && aws_s3_bucket.state.force_destroy == false && aws_s3_bucket.artifacts.bucket != aws_s3_bucket.state.bucket
    error_message = "State and releases must be separate retained buckets."
  }
  assert {
    condition     = length(aws_s3_bucket_versioning.private) == 2 && alltrue([for v in aws_s3_bucket_versioning.private : v.versioning_configuration[0].status == "Enabled"])
    error_message = "Both buckets must retain versions."
  }
  assert {
    condition     = length(aws_s3_bucket_server_side_encryption_configuration.private) == 2 && alltrue([for v in aws_s3_bucket_server_side_encryption_configuration.private : one(v.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"])
    error_message = "Both buckets require SSE-S3."
  }
  assert {
    condition     = length(aws_s3_bucket_public_access_block.private) == 2 && alltrue([for b in aws_s3_bucket_public_access_block.private : b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets])
    error_message = "Both buckets must block all public access."
  }
  assert {
    condition     = alltrue([for b in aws_s3_bucket_policy.private : anytrue([for s in jsondecode(b.policy).Statement : s.Sid == "DenyInsecureTransport" && s.Effect == "Deny" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"])])
    error_message = "Both buckets must deny insecure transport."
  }
  assert {
    condition     = anytrue([for s in jsondecode(aws_s3_bucket_policy.private["artifacts"].policy).Statement : s.Sid == "RequireCreateOnlyWrite" && s.Effect == "Deny" && s.Action == "s3:PutObject" && try(s.Condition.StringNotEquals["s3:if-none-match"], "") == "*"])
    error_message = "Releases must require If-None-Match star."
  }
}

run "trust_is_exact_oidc_subject" {
  command = plan
  assert {
    condition     = alltrue([for role in aws_iam_role.github : alltrue([for s in jsondecode(role.assume_role_policy).Statement : s.Action == "sts:AssumeRoleWithWebIdentity" && s.Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" && s.Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com" && s.Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:synthetic/reminder-server:environment:production" && !can(s.Condition.StringLike)])])
    error_message = "All three roles require exact audience and explicit subject."
  }
  assert {
    condition     = length(toset([for r in aws_iam_role.github : r.name])) == 3
    error_message = "Registration, plan and apply must be distinct roles."
  }
}

run "roles_cannot_delete_artifacts_or_manage_cognito_users" {
  command = plan
  assert {
    condition = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for statement in jsondecode(policy).Statement : alltrue([for action in statement.Action : !startswith(action, "cognito-idp:") || contains([
      "cognito-idp:CreateUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool", "cognito-idp:DescribeUserPool", "cognito-idp:GetUserPoolMfaConfig", "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:CreateUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient", "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:CreateUserPoolDomain", "cognito-idp:UpdateUserPoolDomain", "cognito-idp:DeleteUserPoolDomain", "cognito-idp:DescribeUserPoolDomain",
      "cognito-idp:CreateResourceServer", "cognito-idp:UpdateResourceServer", "cognito-idp:DeleteResourceServer", "cognito-idp:DescribeResourceServer", "cognito-idp:ListResourceServers",
      "cognito-idp:TagResource", "cognito-idp:UntagResource", "cognito-idp:ListTagsForResource"
    ], action)])])])
    error_message = "Cognito permissions must only configure pools, clients, domains, resource servers and tags."
  }
  assert {
    condition     = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for s in jsondecode(policy).Statement : s.Effect != "Allow" || alltrue([for a in s.Action : !startswith(a, "cognito-idp:Admin") && !endswith(a, ":*") && !contains(["cognito-idp:*", "cognito-idp:AdminCreateUser", "cognito-idp:AdminDeleteUser", "cognito-idp:ListUsers", "lambda:InvokeFunction", "execute-api:Invoke", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "s3:*", "iam:*"], a)])])])
    error_message = "Delivery roles must have no runtime data/user/invoke or service-wide permissions."
  }
  assert {
    condition     = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for s in jsondecode(policy).Statement : s.Effect != "Allow" || !contains(s.Action, "s3:DeleteObjectVersion") && (!contains(s.Action, "s3:DeleteObject") || alltrue([for r in s.Resource : endswith(r, ".tflock")]))])])
    error_message = "Only state lockfiles can be deleted."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.github["artifact"].policy).Statement : s.Effect != "Allow" || s.Resource == ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-artifacts/releases/*/reminder-server.zip"] && alltrue([for a in s.Action : contains(["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"], a)])])
    error_message = "Registration only reads/writes the release ZIP prefix."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.github["plan"].policy).Statement : s.Effect != "Allow" || !contains(s.Action, "s3:PutObject") || alltrue([for r in s.Resource : endswith(r, ".tflock")])]) && anytrue([for s in jsondecode(aws_iam_role_policy.github["plan"].policy).Statement : contains(s.Action, "s3:PutObject") && length(s.Resource) == 2])
    error_message = "Plan may write only the two production state lockfiles."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : !contains(s.Action, "iam:PassRole") || length(s.Resource) <= 2 && alltrue([for r in s.Resource : contains(["arn:aws:iam::123456789012:role/synthetic-reminder-production-api", "arn:aws:iam::123456789012:role/synthetic-reminder-production-cleanup", "arn:aws:iam::123456789012:role/synthetic-reminder-production-scheduler"], r)]) && contains(["lambda.amazonaws.com", "scheduler.amazonaws.com"], s.Condition.StringEquals["iam:PassedToService"])])
    error_message = "PassRole requires exact runtime roles and service conditions."
  }
  assert {
    condition = alltrue([for p in aws_iam_role_policy.github : alltrue([for statement in jsondecode(p.policy).Statement : !contains(statement.Action, "s3:GetObject") && !contains(statement.Action, "s3:PutObject") || alltrue([for resource in statement.Resource : contains([
      "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-artifacts/releases/*/reminder-server.zip",
      "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-state/production/platform/terraform.tfstate",
      "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-state/production/application/terraform.tfstate",
      "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-state/production/platform/terraform.tfstate.tflock",
      "arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-state/production/application/terraform.tfstate.tflock"
    ], resource)])])])
    error_message = "S3 object access is restricted to release ZIPs and exact production state/locks."
  }
  assert {
    condition     = alltrue([for p in aws_iam_role_policy.github : alltrue([for statement in jsondecode(p.policy).Statement : !contains(statement.Action, "s3:ListBucket") || statement.Resource == ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-state"] && toset(statement.Condition.StringEquals["s3:prefix"]) == toset(["production/platform/terraform.tfstate", "production/application/terraform.tfstate"])])])
    error_message = "State listing must use exact production key prefixes."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : !anytrue([for action in statement.Action : startswith(action, "scheduler:")]) || toset(statement.Resource) == toset([
      "arn:aws:scheduler:us-east-1:123456789012:schedule/synthetic-reminder-production-cleanup/synthetic-reminder-production-cleanup",
      "arn:aws:scheduler:us-east-1:123456789012:schedule-group/synthetic-reminder-production-cleanup"
    ])])
    error_message = "Scheduler access must use only the dedicated production cleanup group and schedule."
  }

}

run "reject_missing_subjects" {
  command = plan
  variables {
    oidc_subjects = { artifact = "", plan = "", apply = "" }
  }
  expect_failures = [var.oidc_subjects]
}

run "reject_wildcard_subjects" {
  command = plan
  variables {
    oidc_subjects = { artifact = "repo:synthetic/reminder-server:*", plan = "repo:synthetic/reminder-server:environment:production", apply = "repo:synthetic/reminder-server:environment:production" }
  }
  expect_failures = [var.oidc_subjects]
}

run "reject_other_repository_subject" {
  command = plan
  variables {
    oidc_subjects = { artifact = "repo:other/reminder-server:environment:production", plan = "repo:synthetic/reminder-server:environment:production", apply = "repo:synthetic/reminder-server:environment:production" }
  }
  expect_failures = [var.oidc_subjects]
}
run "reject_account_and_region" {
  command = plan
  variables {
    account_id = ""
    region     = "us-gov-east-1"
  }
  expect_failures = [var.account_id, var.region]
}

run "required_gateway_logging_and_iam_size" {
  command = plan
  assert {
    condition     = alltrue([for p in aws_iam_role_policy.github : length(p.policy) <= 10240]) && length(aws_iam_policy.production_read.policy) <= 6144 && toset(keys(aws_iam_role_policy_attachment.production_read)) == toset(["plan", "apply"])
    error_message = "Role inline policies must fit the IAM 10240-character aggregate limit."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : contains(statement.Action, "logs:CreateLogDelivery") && contains(statement.Action, "logs:PutResourcePolicy")])
    error_message = "HTTP API logging needs documented delivery/policy configuration permissions."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : contains(statement.Action, "iam:CreateServiceLinkedRole") && statement.Resource == ["arn:aws:iam::123456789012:role/aws-service-role/ops.apigateway.amazonaws.com/AWSServiceRoleForAPIGateway"] && statement.Condition.StringEquals["iam:AWSServiceName"] == "ops.apigateway.amazonaws.com"])
    error_message = "API creation may create only its exact service-linked role."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : contains(statement.Action, "logs:PutRetentionPolicy") && contains(statement.Resource, "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/synthetic-reminder-production-api")])
    error_message = "The API access log group needs scoped retention management."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : contains(statement.Action, "lambda:UpdateFunctionCode") && contains(statement.Resource, "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-api") && contains(statement.Resource, "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup")])
    error_message = "Lambda management requires valid exact function ARNs."
  }

}

run "maximum_bucket_name_keeps_policies_in_aws_limits" {
  command = plan
  variables {
    name_prefix = "abcdefghijklmnopqrstuvwxy"
    region      = "ap-southeast-1"
  }
  assert {
    condition     = length(aws_s3_bucket.artifacts.bucket) == 63 && alltrue([for p in aws_iam_role_policy.github : length(p.policy) <= 10240]) && length(aws_iam_policy.production_read.policy) <= 6144
    error_message = "Longest permitted bucket names must retain precise policy scopes within AWS quotas."
  }
}
run "reject_overlong_bucket_name" {
  command = plan
  variables {
    name_prefix = "abcdefghijklmnopqrstuvwxyz"
    region      = "ap-southeast-1"
  }
  expect_failures = [var.name_prefix]
}

run "cognito_pool_configuration_reads_cover_pinned_provider" {
  command = plan
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_policy.production_read.policy).Statement : contains(statement.Action, "cognito-idp:GetUserPoolMfaConfig") && contains(statement.Action, "cognito-idp:DescribeResourceServer")])
    error_message = "Pinned provider must be able to read pool MFA configuration and OAuth resource server configuration."
  }
}

# Catches omitted owner-state/image-jobs metadata or provisioning permissions,
# replacement of exact table ARNs by wildcards, and accidental data permissions.
run "all_three_tables_have_only_configuration_rights" {
  command = plan
  assert {
    condition = alltrue([for table in ["reminders", "owner-state", "image-jobs"] : anytrue([
      for statement in jsondecode(aws_iam_policy.production_read.policy).Statement :
      contains(statement.Resource, "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-${table}") && alltrue([
        for action in ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource"] : contains(statement.Action, action)
      ])
    ])])
    error_message = "Plan/apply must read metadata, PITR, TTL and tags for reminders, owner-state and image-jobs."
  }
  assert {
    condition = alltrue([for table in ["reminders", "owner-state", "image-jobs"] : anytrue([
      for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement :
      contains(statement.Resource, "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-${table}") && alltrue([
        for action in ["dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:DeleteTable", "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateTimeToLive", "dynamodb:TagResource", "dynamodb:UntagResource"] : contains(statement.Action, action)
      ])
    ])])
    error_message = "Apply must provision and manage configuration for all three exact runtime tables."
  }
  assert {
    condition = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([
      for statement in jsondecode(policy).Statement : !anytrue([for action in statement.Action : startswith(action, "dynamodb:")]) || toset(statement.Resource) == toset([
        "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders",
        "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state",
        "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs"
        ]) && alltrue([for action in statement.Action : contains([
          "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource",
          "dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:DeleteTable", "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateTimeToLive", "dynamodb:TagResource", "dynamodb:UntagResource"
      ], action)])
    ])])
    error_message = "All DynamoDB grants must use exactly three table ARNs and configuration actions only, never data or wildcard permissions."
  }
}
