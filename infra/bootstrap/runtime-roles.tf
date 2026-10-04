# Bootstrap alone owns service trusts and ceilings. Downstream roots attach
# inline grants; a boundary never grants access itself. Explicit denials also
# constrain direct session resource-policy grants (implicit boundary denies do not).
# https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
locals {
  runtime_role_arns    = { for key in ["api", "cleanup", "scheduler"] : key => "arn:aws:iam::${var.account_id}:role/${local.production}-${key}" }
  runtime_ceiling_arns = { for key in ["api", "cleanup", "scheduler"] : key => "arn:aws:iam::${var.account_id}:policy/${local.production}-${key}-ceiling" }
  runtime_function_arns = {
    for key in ["api", "cleanup"] : key => "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-${key}"
  }
  runtime_table_arns   = { for key in ["reminders", "owner-state", "image-jobs"] : key => "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-${key}" }
  runtime_image_bucket = "arn:aws:s3:::${var.name_prefix}-${var.account_id}-${var.region}-images"
  runtime_log_arns     = { for key in ["api", "cleanup"] : key => "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-${key}:*" }

  # TransactWriteItems is authorized through PutItem/UpdateItem/DeleteItem, not
  # a TransactWriteItems IAM action. These adapters use only Put and Update.
  # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html
  runtime_operations = {
    api = [
      { Action = ["dynamodb:GetItem"], Resource = values(local.runtime_table_arns) },
      { Action = ["dynamodb:PutItem"], Resource = [local.runtime_table_arns.reminders, local.runtime_table_arns["image-jobs"]] },
      { Action = ["dynamodb:UpdateItem"], Resource = [local.runtime_table_arns["owner-state"], local.runtime_table_arns["image-jobs"]] },
      { Action = ["dynamodb:Query"], Resource = [local.runtime_table_arns.reminders] },
      # HeadBucket readiness needs ListBucket; signed version GET uses GetObjectVersion.
      { Action = ["s3:ListBucket"], Resource = [local.runtime_image_bucket] },
      { Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], Resource = ["${local.runtime_image_bucket}/images/*"] },
      { Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [local.runtime_log_arns.api] }
    ]
    cleanup = [
      { Action = ["dynamodb:GetItem"], Resource = [local.runtime_table_arns["owner-state"], local.runtime_table_arns["image-jobs"]] },
      { Action = ["dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = [local.runtime_table_arns["image-jobs"]] },
      { Action = ["dynamodb:Query"], Resource = ["${local.runtime_table_arns["image-jobs"]}/index/cleanup_by_due"] },
      # A missing-key HEAD returns 404 only with ListBucket (otherwise 403).
      # No prefix condition: HeadObject does not send a ListObjects prefix.
      # https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
      { Action = ["s3:ListBucket"], Resource = [local.runtime_image_bucket] },
      { Action = ["s3:GetObject", "s3:DeleteObject"], Resource = ["${local.runtime_image_bucket}/images/*"] },
      { Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [local.runtime_log_arns.cleanup] },
      { Action = ["cloudwatch:PutMetricData"], Resource = ["*"] }
    ]
    scheduler = [
      { Action = ["lambda:InvokeFunction"], Resource = ["${local.runtime_function_arns.cleanup}:production"] }
    ]
  }
  runtime_actions = { for key, statements in local.runtime_operations : key => distinct(flatten([for statement in statements : statement.Action])) }
  # Lambda adds this context to runtime SDK requests and automatic log delivery.
  # Use the unqualified function ARN; aliases/versions are unsupported here.
  # Explicit ArnNotEquals denies absent or different source-function context and
  # prevents role swaps from gaining distinct runtime writes/data/log privileges.
  # Browser-consumed pinned version GET is the only bounded alternative below.
  # https://docs.aws.amazon.com/lambda/latest/dg/permissions-source-function-arn.html
  runtime_source_conditions = { for key in ["api", "cleanup"] : key => { ArnEquals = { "lambda:SourceFunctionArn" = local.runtime_function_arns[key] } } }
  runtime_function_guard_actions = {
    for key, actions in local.runtime_actions : key => [for action in actions : action if key != "api" || action != "s3:GetObjectVersion"]
  }
  # Browser requests are not documented to carry Lambda source-function context.
  # Permit only pinned version reads using SigV4 query authentication, with a
  # present signature age <=900 seconds; retain every finite action/resource deny.
  # https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/additional-guardrails.html
  runtime_presigned_version = [
    { Effect = "Allow", Action = ["s3:GetObjectVersion"], Resource = ["${local.runtime_image_bucket}/images/*"], Condition = {
      StringEquals          = { "s3:authType" = "REST-QUERY-STRING", "s3:signatureversion" = "AWS4-HMAC-SHA256" }
      NumericLessThanEquals = { "s3:signatureAge" = 900000 }
      Null                  = { "s3:signatureAge" = "false" }
    } },
    # Absent/mismatched function context requires query authentication. Negated
    # operators also match missing keys; no IfExists relaxation is used.
    { Effect = "Deny", Action = ["s3:GetObjectVersion"], Resource = ["*"], Condition = {
      ArnNotEquals    = { "lambda:SourceFunctionArn" = local.runtime_function_arns.api }
      StringNotEquals = { "s3:authType" = "REST-QUERY-STRING" }
    } },
    { Effect = "Deny", Action = ["s3:GetObjectVersion"], Resource = ["*"], Condition = {
      StringEquals       = { "s3:authType" = "REST-QUERY-STRING" }
      NumericGreaterThan = { "s3:signatureAge" = 900000 }
    } },
    { Effect = "Deny", Action = ["s3:GetObjectVersion"], Resource = ["*"], Condition = {
      StringEquals = { "s3:authType" = "REST-QUERY-STRING" }
      Null         = { "s3:signatureAge" = "true" }
    } },
    { Effect = "Deny", Action = ["s3:GetObjectVersion"], Resource = ["*"], Condition = {
      StringEquals    = { "s3:authType" = "REST-QUERY-STRING" }
      StringNotEquals = { "s3:signatureversion" = "AWS4-HMAC-SHA256" }
    } }
  ]
  runtime_ceiling_statements = {
    for key, statements in local.runtime_operations : key => concat(
      [for statement in statements : merge(statement, { Effect = "Allow" }, key == "scheduler" ? {} : { Condition = merge(local.runtime_source_conditions[key], contains(statement.Action, "cloudwatch:PutMetricData") ? { StringEquals = { "cloudwatch:namespace" = "ReminderServer", "aws:RequestedRegion" = var.region } } : {}) })],
      [{ Effect = "Deny", NotAction = local.runtime_actions[key], Resource = ["*"] }],
      # Explicit resource denials close session resource-policy escape paths.
      [for statement in statements : { Effect = "Deny", Action = statement.Action, NotResource = statement.Resource } if !contains(statement.Resource, "*")],
      key == "scheduler" ? [] : [{ Effect = "Deny", Action = local.runtime_function_guard_actions[key], Resource = ["*"], Condition = { ArnNotEquals = { "lambda:SourceFunctionArn" = local.runtime_function_arns[key] } } }],
      key == "api" ? local.runtime_presigned_version : [],
      key != "cleanup" ? [] : [
        { Effect = "Deny", Action = ["cloudwatch:PutMetricData"], Resource = ["*"], Condition = { StringNotEquals = { "cloudwatch:namespace" = "ReminderServer" } } },
        { Effect = "Deny", Action = ["cloudwatch:PutMetricData"], Resource = ["*"], Condition = { StringNotEquals = { "aws:RequestedRegion" = var.region } } }
      ]
    )
  }
  runtime_ceiling_text = { for key, statements in local.runtime_ceiling_statements : key => jsonencode({ Version = "2012-10-17", Statement = statements }) }
  runtime_ownership_denials = [
    { Effect = "Deny", Action = ["iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:TagRole", "iam:UntagRole"], Resource = values(local.runtime_role_arns) },
    { Effect = "Deny", Action = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"], Resource = values(local.runtime_ceiling_arns) }
  ]
}

resource "aws_iam_policy" "runtime_ceiling" {
  for_each    = local.runtime_ceiling_text
  name        = "${local.production}-${each.key}-ceiling"
  description = "Bootstrap-owned immutable ${each.key} runtime permissions ceiling"
  policy      = each.value
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(each.value) <= 6144
      error_message = "Runtime ceiling exceeds the managed policy limit; retain exact scopes."
    }
  }
}

resource "aws_iam_role" "runtime" {
  for_each             = local.runtime_role_arns
  name                 = "${local.production}-${each.key}"
  description          = "Bootstrap-owned production ${each.key} service identity"
  permissions_boundary = local.runtime_ceiling_arns[each.key]
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [merge({
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = each.key == "scheduler" ? "scheduler.amazonaws.com" : "lambda.amazonaws.com" }
      }, each.key == "scheduler" ? { Condition = { StringEquals = {
        "aws:SourceAccount" = var.account_id
        "aws:SourceArn"     = "arn:aws:scheduler:${var.region}:${var.account_id}:schedule-group/${local.production}-cleanup"
    } } } : {})]
  })
  depends_on = [aws_iam_policy.runtime_ceiling]
  lifecycle { prevent_destroy = true }
}
