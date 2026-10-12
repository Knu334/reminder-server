# Mutations caught: public/unversioned storage, broad OIDC trust, artifact deletion,
# state writes by plan, data/user permissions, and unrestricted PassRole.
mock_provider "aws" {}

variables {
  account_id         = "123456789012"
  region             = "us-east-1"
  repository         = "synthetic/reminder-server"
  github_environment = "production"
  oidc_subjects = {
    artifact = "repo:synthetic/reminder-server:environment:production-artifact"
    plan     = "repo:synthetic/reminder-server:environment:production-plan"
    apply    = "repo:synthetic/reminder-server:environment:production"
  }
  name_prefix       = "synthetic-reminder"
  production_api_id = "a1b2c3d4e5"
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
    condition     = alltrue([for key, role in aws_iam_role.github : alltrue([for s in jsondecode(role.assume_role_policy).Statement : s.Action == "sts:AssumeRoleWithWebIdentity" && s.Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" && s.Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com" && s.Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.oidc_subjects[key] && !can(s.Condition.StringLike)])])
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
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : !contains(statement.Action, "iam:CreateServiceLinkedRole")])
    error_message = "First API/service-linked role creation belongs to the separate operator seed, never GHA."
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
    condition     = length(aws_s3_bucket.artifacts.bucket) == 63 && alltrue([for p in aws_iam_role_policy.github : length(p.policy) <= 10240]) && length(aws_iam_policy.production_read.policy) <= 6144 && alltrue([for p in aws_iam_policy.runtime_ceiling : length(p.policy) <= 6144])
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

run "delivery_cannot_mutate_runtime_role_ownership" {
  command = plan
  assert {
    condition = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([
      for statement in jsondecode(policy).Statement : statement.Effect != "Allow" || alltrue([for action in statement.Action : !contains([
        "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:AttachRolePolicy", "iam:DetachRolePolicy"
      ], action)])
    ])])
    error_message = "GHA must not create/delete runtime roles, rewrite trust or remove/replace/edit ceilings."
  }
  assert {
    condition     = alltrue([for p in aws_iam_role_policy.github : anytrue([for statement in jsondecode(p.policy).Statement : statement.Effect == "Deny" && contains(statement.Action, "iam:UpdateAssumeRolePolicy") && contains(statement.Action, "iam:DeleteRolePermissionsBoundary") && length(statement.Resource) == 3]) && anytrue([for statement in jsondecode(p.policy).Statement : statement.Effect == "Deny" && contains(statement.Action, "iam:CreatePolicyVersion") && contains(statement.Action, "iam:SetDefaultPolicyVersion") && length(statement.Resource) == 3])])
    error_message = "All delivery principals need explicit runtime trust/boundary and ceiling policy mutation denials."
  }
}

run "bootstrap_owns_separate_runtime_trust_and_ceilings" {
  command = plan
  assert {
    condition     = toset(keys(aws_iam_role.runtime)) == toset(["api", "cleanup", "scheduler"]) && alltrue([for key, role in aws_iam_role.runtime : role.name == "synthetic-reminder-production-${key}" && role.permissions_boundary == "arn:aws:iam::123456789012:policy/synthetic-reminder-production-${key}-ceiling" && length(jsondecode(role.assume_role_policy).Statement) == 1 && one(jsondecode(role.assume_role_policy).Statement).Action == "sts:AssumeRole" && one(jsondecode(role.assume_role_policy).Statement).Principal.Service == (key == "scheduler" ? "scheduler.amazonaws.com" : "lambda.amazonaws.com") && !can(one(jsondecode(role.assume_role_policy).Statement).Principal.Federated)])
    error_message = "Each bootstrap-owned runtime identity needs its own mandatory ceiling and service-only immutable trust."
  }
  assert {
    condition = one(jsondecode(aws_iam_role.runtime["scheduler"].assume_role_policy).Statement).Condition.StringEquals == {
      "aws:SourceAccount" = "123456789012"
      "aws:SourceArn"     = "arn:aws:scheduler:us-east-1:123456789012:schedule-group/synthetic-reminder-production-cleanup"
    }
    error_message = "Scheduler trust is constrained to the exact account and dedicated group."
  }
  assert {
    condition     = alltrue([for p in aws_iam_policy.runtime_ceiling : length(p.policy) <= 6144 && anytrue([for statement in jsondecode(p.policy).Statement : statement.Effect == "Deny" && can(statement.NotAction) && statement.Resource == ["*"] && alltrue([for action in statement.NotAction : !startswith(action, "iam:") && !startswith(action, "sts:") && !startswith(action, "cognito-idp:") && !strcontains(action, "*")])])])
    error_message = "Even adversarial Allow-star inline policies cannot escape the finite explicit action ceilings."
  }
  assert {
    condition     = alltrue([for key in ["api", "cleanup"] : anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect == "Deny" && try(statement.Condition.ArnNotEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-${key}"])])
    error_message = "Swapping API/cleanup execution roles must not bypass their function-specific ceilings."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["scheduler"].policy).Statement : statement.Effect != "Allow" || statement.Action == ["lambda:InvokeFunction"] && statement.Resource == ["arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup:production"]]) && alltrue([for key in ["api", "cleanup"] : alltrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect != "Allow" || !contains(statement.Action, "lambda:InvokeFunction") && !contains(statement.Action, "s3:DeleteObjectVersion")])])
    error_message = "Scheduler can invoke only cleanup's production alias; Lambda identities cannot invoke functions or purge image versions."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect != "Allow" || !contains(statement.Action, "s3:DeleteObject")]) && anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : statement.Effect == "Allow" && contains(statement.Action, "s3:ListBucket") && statement.Resource == ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images"] && !can(statement.Condition["StringEquals"]["s3:prefix"])])
    error_message = "API cannot delete image objects; cleanup needs exact-bucket listing for missing-key HEAD to return 404."
  }
}

run "absent_api_id_has_no_http_api_control" {
  command = plan
  variables { production_api_id = null }
  assert {
    condition     = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for statement in jsondecode(policy).Statement : statement.Effect != "Allow" || alltrue([for action in statement.Action : !startswith(action, "apigateway:")])])])
    error_message = "An absent known API ID must grant no GHA HTTP API management, including root creation."
  }
}

run "known_api_id_is_scoped_without_parent_tag_assumptions" {
  command = plan
  variables { production_api_id = "a1b2c3d4e5" }
  assert {
    condition     = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for statement in jsondecode(policy).Statement : !anytrue([for action in statement.Action : startswith(action, "apigateway:")]) || toset(statement.Resource) == toset(["arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5", "arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5/*"]) && !can(statement.Condition)])]) && anytrue([for statement in jsondecode(aws_iam_role_policy.github["apply"].policy).Statement : contains(statement.Action, "apigateway:POST") && contains(statement.Action, "apigateway:PATCH") && contains(statement.Action, "apigateway:DELETE")])
    error_message = "Only the explicit API and its child ARNs may be managed, without tags/IfExists or foreign API wildcards."
  }
}
run "different_api_id_does_not_retain_old_or_foreign_scope" {
  command = plan
  variables { production_api_id = "z9y8x7w6v5" }
  assert {
    condition     = alltrue([for policy in concat([for p in aws_iam_role_policy.github : p.policy], [aws_iam_policy.production_read.policy]) : alltrue([for statement in jsondecode(policy).Statement : !anytrue([for action in statement.Action : startswith(action, "apigateway:")]) || toset(statement.Resource) == toset(["arn:aws:apigateway:us-east-1::/apis/z9y8x7w6v5", "arn:aws:apigateway:us-east-1::/apis/z9y8x7w6v5/*"])])])
    error_message = "Configured API IDs must not authorize any different API."
  }
}
run "reject_api_scope_injection" {
  command = plan
  variables { production_api_id = "a1b2c3d4e5/*" }
  expect_failures = [var.production_api_id]
}

# The literal adapter inventory below is independent of implementation locals.
# Every permitted action has an explicit out-of-scope resource denial, including
# adversarial Allow-star inline policies or a direct session resource policy.
run "runtime_ceilings_enforce_exact_operation_scopes" {
  command = plan
  assert {
    condition = toset(flatten([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : try(statement.Effect, "") == "Allow" ? statement.Action : []])) == toset(keys(jsondecode("{\"dynamodb:GetItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:PutItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:UpdateItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:Query\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\"],\"s3:ListBucket\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images\"],\"s3:GetObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:GetObjectVersion\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:PutObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"logs:CreateLogStream\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*\"],\"logs:PutLogEvents\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*\"]}"))) && alltrue([for action, resources in jsondecode("{\"dynamodb:GetItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:PutItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:UpdateItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:Query\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-reminders\"],\"s3:ListBucket\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images\"],\"s3:GetObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:GetObjectVersion\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:PutObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"logs:CreateLogStream\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*\"],\"logs:PutLogEvents\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-api:*\"]}") :
      toset(flatten([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : try(statement.Resource, []) if statement.Effect == "Allow" && contains(try(statement.Action, []), action)])) == toset(resources) &&
      (resources == ["*"] || anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Deny" && contains(try(statement.Action, []), action) && toset(try(statement.NotResource, [])) == toset(resources)]))
    ])
    error_message = "api ceiling must exactly match the adapter inventory and explicitly deny foreign resources, state and artifacts."
  }
  assert {
    condition = toset(flatten([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : try(statement.Effect, "") == "Allow" ? statement.Action : []])) == toset(keys(jsondecode("{\"dynamodb:GetItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:PutItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:UpdateItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:Query\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs/index/cleanup_by_due\"],\"s3:ListBucket\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images\"],\"s3:GetObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:DeleteObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"logs:CreateLogStream\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*\"],\"logs:PutLogEvents\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*\"],\"cloudwatch:PutMetricData\":[\"*\"]}"))) && alltrue([for action, resources in jsondecode("{\"dynamodb:GetItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-owner-state\",\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:PutItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:UpdateItem\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs\"],\"dynamodb:Query\":[\"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-reminder-production-image-jobs/index/cleanup_by_due\"],\"s3:ListBucket\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images\"],\"s3:GetObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"s3:DeleteObject\":[\"arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*\"],\"logs:CreateLogStream\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*\"],\"logs:PutLogEvents\":[\"arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/synthetic-reminder-production-cleanup:*\"],\"cloudwatch:PutMetricData\":[\"*\"]}") :
      anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : statement.Effect == "Allow" && contains(try(statement.Action, []), action) && toset(try(statement.Resource, [])) == toset(resources)]) &&
      (resources == ["*"] || anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : statement.Effect == "Deny" && contains(try(statement.Action, []), action) && toset(try(statement.NotResource, [])) == toset(resources)]))
    ])
    error_message = "cleanup ceiling must exactly match the adapter inventory and explicitly deny foreign resources, state and artifacts."
  }
  assert {
    condition = toset(flatten([for statement in jsondecode(aws_iam_policy.runtime_ceiling["scheduler"].policy).Statement : try(statement.Effect, "") == "Allow" ? statement.Action : []])) == toset(keys(jsondecode("{\"lambda:InvokeFunction\":[\"arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup:production\"]}"))) && alltrue([for action, resources in jsondecode("{\"lambda:InvokeFunction\":[\"arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-cleanup:production\"]}") :
      anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["scheduler"].policy).Statement : statement.Effect == "Allow" && contains(try(statement.Action, []), action) && toset(try(statement.Resource, [])) == toset(resources)]) &&
      (resources == ["*"] || anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["scheduler"].policy).Statement : statement.Effect == "Deny" && contains(try(statement.Action, []), action) && toset(try(statement.NotResource, [])) == toset(resources)]))
    ])
    error_message = "scheduler ceiling must exactly match the adapter inventory and explicitly deny foreign resources, state and artifacts."
  }
  assert {
    condition     = alltrue([for key in ["api", "cleanup", "scheduler"] : anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect == "Deny" && toset(try(statement.NotAction, [])) == toset(flatten([for allow in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : allow.Effect == "Allow" ? allow.Action : []])) && statement.Resource == ["*"]])])
    error_message = "An arbitrary IAM/STS/Cognito grant must encounter an explicit Deny outside the exact runtime action inventory."
  }
  assert {
    condition     = alltrue([for key in ["api", "cleanup"] : alltrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect != "Allow" || (key == "api" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Condition.StringEquals["s3:authType"], "") == "REST-QUERY-STRING") || try(statement.Condition.ArnEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-${key}"]) && anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect == "Deny" && try(statement.Condition.ArnNotEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-${key}" && toset(try(statement.Action, [])) == toset([for action in flatten([for allow in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : allow.Effect == "Allow" ? allow.Action : []]) : action if key != "api" || action != "s3:GetObjectVersion"])])])
    error_message = "Absent/mismatched source-function context must explicitly deny all ordinary runtime operations, including automatic logs; the bounded version-GET alternative is checked separately."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : statement.Effect == "Allow" && contains(try(statement.Action, []), "cloudwatch:PutMetricData") && try(statement.Condition.StringEquals["cloudwatch:namespace"], "") == "ReminderServer" && try(statement.Condition.StringEquals["aws:RequestedRegion"], "") == "us-east-1"]) && alltrue([for condition_key, value in { "cloudwatch:namespace" = "ReminderServer", "aws:RequestedRegion" = "us-east-1" } : anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["cleanup"].policy).Statement : statement.Effect == "Deny" && contains(try(statement.Action, []), "cloudwatch:PutMetricData") && try(statement.Condition.StringNotEquals[condition_key], "") == value])])
    error_message = "Metric publishing must explicitly deny either a wrong region or wrong namespace independently."
  }
}

run "reject_empty_api_id" {
  command = plan
  variables { production_api_id = "" }
  expect_failures = [var.production_api_id]
}

run "presigned_version_read_is_api_only_and_bounded" {
  command = plan
  assert {
    condition     = length([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement if statement.Effect == "Allow" && !can(statement.Condition.ArnEquals)]) == 1
    error_message = "Exactly one Allow may omit the API source-function guard; additional exceptions are forbidden."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Allow" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Resource, []) == ["arn:aws:s3:::synthetic-reminder-123456789012-us-east-1-images/images/*"] && !can(statement.Condition.ArnEquals) && try(statement.Condition.StringEquals["s3:authType"], "") == "REST-QUERY-STRING" && try(statement.Condition.StringEquals["s3:signatureversion"], "") == "AWS4-HMAC-SHA256" && try(tonumber(statement.Condition.NumericLessThanEquals["s3:signatureAge"]), 0) == 900000 && try(statement.Condition.Null["s3:signatureAge"], "") == "false"])
    error_message = "Browser-consumed version GET needs only an API ceiling exception for SigV4 query authentication and <=900-second signature age."
  }
  assert {
    condition     = alltrue([for key in ["cleanup", "scheduler"] : alltrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling[key].policy).Statement : statement.Effect != "Allow" || !contains(try(statement.Action, []), "s3:GetObjectVersion")])]) && anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Deny" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Condition.ArnNotEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:123456789012:function:synthetic-reminder-production-api" && try(statement.Condition.StringNotEquals["s3:authType"], "") == "REST-QUERY-STRING"])
    error_message = "Cleanup must not gain version reads; ordinary API SDK version reads stay function-bound, including missing authentication context."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Deny" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Condition.StringEquals["s3:authType"], "") == "REST-QUERY-STRING" && try(tonumber(statement.Condition.NumericGreaterThan["s3:signatureAge"]), 0) == 900000]) && anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Deny" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Condition.StringEquals["s3:authType"], "") == "REST-QUERY-STRING" && try(statement.Condition.Null["s3:signatureAge"], "") == "true"]) && anytrue([for statement in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : statement.Effect == "Deny" && try(statement.Action, []) == ["s3:GetObjectVersion"] && try(statement.Condition.StringEquals["s3:authType"], "") == "REST-QUERY-STRING" && try(statement.Condition.StringNotEquals["s3:signatureversion"], "") == "AWS4-HMAC-SHA256"])
    error_message = "Even Allow-star/session resource grants must not bypass expired/missing-age or non-SigV4 query conditions."
  }
}

run "reject_collapsed_environments" {
  command = plan
  variables { oidc_subjects = { artifact = "repo:synthetic/reminder-server:environment:production", plan = "repo:synthetic/reminder-server:environment:production", apply = "repo:synthetic/reminder-server:environment:production" } }
  expect_failures = [var.oidc_subjects]
}
run "reject_branch_subject" {
  command = plan
  variables { oidc_subjects = { artifact = "repo:synthetic/reminder-server:ref:refs/heads/main", plan = "repo:synthetic/reminder-server:environment:production-plan", apply = "repo:synthetic/reminder-server:environment:production" } }
  expect_failures = [var.oidc_subjects]
}

run "restored_table_ceiling_is_finite" {
  command = plan
  variables { restored_tables = { reminders = "synthetic-restore-reminders", owner_state = "synthetic-restore-owners", image_jobs = "synthetic-restore-jobs" } }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_policy.runtime_ceiling["api"].policy).Statement : try(s.Resource, []) if s.Effect == "Allow" && contains(try(s.Action, []), "dynamodb:GetItem")])) == toset(["arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-restore-reminders", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-restore-owners", "arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-restore-jobs"])
    error_message = "Bootstrap must select only the reviewed restored table set, never arbitrary tables."
  }
}

run "reject_restored_partial" {
  command = plan
  variables { restored_tables = { reminders = "restore-reminders" } }
  expect_failures = [var.restored_tables]
}

run "reject_restored_alias_original" {
  command = plan
  variables { restored_tables = { reminders = "synthetic-reminder-production-owner-state", owner_state = "restore-owners", image_jobs = "restore-jobs" } }
  expect_failures = [var.restored_tables]
}

run "reject_restored_duplicate" {
  command = plan
  variables { restored_tables = { reminders = "restore-same", owner_state = "restore-same", image_jobs = "restore-jobs" } }
  expect_failures = [var.restored_tables]
}

run "reject_restored_wildcard" {
  command = plan
  variables { restored_tables = { reminders = "restore-*", owner_state = "restore-owners", image_jobs = "restore-jobs" } }
  expect_failures = [var.restored_tables]
}

run "reject_extra_oidc_role" {
  command = plan
  variables { oidc_subjects = { artifact = "repo:synthetic/reminder-server:environment:production-artifact", plan = "repo:synthetic/reminder-server:environment:production-plan", apply = "repo:synthetic/reminder-server:environment:production", admin = "repo:synthetic/reminder-server:environment:production" } }
  expect_failures = [var.oidc_subjects]
}

run "maximum_restored_names_fit_policy_limits" {
  command = plan
  variables {
    name_prefix = "abcdefghijklmnopqrstuvwxyz"
    region      = "us-east-1"
    restored_tables = {
      reminders   = "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
      owner_state = "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo"
      image_jobs  = "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj"
    }
  }
  assert {
    condition     = alltrue([for p in aws_iam_policy.runtime_ceiling : length(p.policy) <= 6144]) && length(aws_iam_policy.production_read.policy) <= 6144 && alltrue([for p in aws_iam_role_policy.github : length(p.policy) <= 10240])
    error_message = "Largest valid prefix and selected table identities must fit all IAM policy limits."
  }
}

run "maximum_bucket_and_restored_names_fit_policy_limits" {
  command = plan
  variables {
    name_prefix = "abcdefghijklmnopqrstuvwxy"
    region      = "ap-southeast-1"
    restored_tables = {
      reminders   = "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
      owner_state = "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo"
      image_jobs  = "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj"
    }
  }
  assert {
    condition     = alltrue([for p in aws_iam_policy.runtime_ceiling : length(p.policy) <= 6144]) && length(aws_iam_policy.production_read.policy) <= 6144 && alltrue([for p in aws_iam_role_policy.github : length(p.policy) <= 10240])
    error_message = "Largest valid prefix and selected table identities must fit all IAM policy limits."
  }
}
