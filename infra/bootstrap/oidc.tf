locals {
  production    = "${var.name_prefix}-production"
  state_keys    = ["production/platform/terraform.tfstate", "production/application/terraform.tfstate"]
  state_objects = [for key in local.state_keys : "${local.bucket_arns.state}/${key}"]
  lock_objects  = [for object in local.state_objects : "${object}.tflock"]
  # Cognito generated IDs use supported pool request/resource tags. HTTP API
  # IDs are separately seeded by an operator and always scoped explicitly:
  # API Gateway does not establish parent-tag inheritance for child controls.
  # DescribeLogGroups/DescribeUserPoolDomain require region-only Resource="*".
  # HTTP API log delivery/resource-policy APIs also require Resource="*";
  # these configuration grants exist only after an explicit API-ID handoff.
  # https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html
  production_api_resources = flatten([for id in [var.production_api_id] : [
    "arn:aws:apigateway:${var.region}::/apis/${id}",
    "arn:aws:apigateway:${var.region}::/apis/${id}/*"
  ] if id != null])
  production_read = concat([for statement in local.production_read_base : statement], [for id in [var.production_api_id] : {
    Effect = "Allow", Action = ["apigateway:GET"], Resource = local.production_api_resources
  } if id != null])
  production_write = concat(local.production_write_base, [for id in [var.production_api_id] : {
    Effect = "Allow", Action = ["apigateway:POST", "apigateway:PATCH", "apigateway:PUT", "apigateway:DELETE"], Resource = local.production_api_resources
    } if id != null], [for id in [var.production_api_id] : {
    Effect    = "Allow"
    Action    = ["logs:CreateLogDelivery", "logs:PutResourcePolicy", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:GetLogDelivery", "logs:ListLogDeliveries", "logs:DescribeResourcePolicies"]
    Resource  = ["*"]
    Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
  } if id != null])
  production_read_base = [
    {
      Sid       = "UserPoolDomainConfiguration"
      Effect    = "Allow"
      Action    = ["cognito-idp:DescribeUserPoolDomain"]
      Resource  = ["*"]
      Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
    },
    {
      "Sid" : "TableConfiguration",
      "Effect" : "Allow",
      "Action" : [
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:ListTagsOfResource"
      ],
      "Resource" : distinct(concat(values(local.runtime_table_arns), [
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-reminders",
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-owner-state",
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-image-jobs"
      ]))
    },
    {
      "Sid" : "ImageBucketConfiguration",
      "Effect" : "Allow",
      "Action" : [
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketTagging",
        "s3:GetBucketCORS",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketAcl"
      ],
      "Resource" : [
        "arn:aws:s3:::${var.name_prefix}-${var.account_id}-${var.region}-images"
      ]
    },
    {
      "Sid" : "Functions",
      "Effect" : "Allow",
      "Action" : [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetFunctionConcurrency",
        "lambda:GetPolicy",
        "lambda:GetAlias",
        "lambda:ListAliases",
        "lambda:ListVersionsByFunction",
        "lambda:ListTags",
        "lambda:GetFunctionEventInvokeConfig"
      ],
      "Resource" : [
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-api",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-cleanup",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-api:*",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-cleanup:*"
      ]
    },
    {
      "Sid" : "RuntimeRoles",
      "Effect" : "Allow",
      "Action" : [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags"
      ],
      "Resource" : [
        "arn:aws:iam::${var.account_id}:role/${local.production}-api",
        "arn:aws:iam::${var.account_id}:role/${local.production}-cleanup",
        "arn:aws:iam::${var.account_id}:role/${local.production}-scheduler"
      ]
    },
    {
      "Sid" : "CognitoConfiguration",
      "Effect" : "Allow",
      "Condition" : { "StringEquals" : { "aws:ResourceTag/Project" : var.name_prefix, "aws:ResourceTag/Environment" : "production" } },
      "Action" : [
        "cognito-idp:DescribeUserPool",
        "cognito-idp:GetUserPoolMfaConfig",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:DescribeResourceServer",
        "cognito-idp:ListTagsForResource",
        "cognito-idp:ListResourceServers"
      ],
      "Resource" : [
        "arn:aws:cognito-idp:${var.region}:${var.account_id}:userpool/*"
      ]
    },
    {
      "Sid" : "Scheduler",
      "Effect" : "Allow",
      "Action" : [
        "scheduler:GetSchedule",
        "scheduler:GetScheduleGroup",
        "scheduler:ListTagsForResource"
      ],
      "Resource" : [
        "arn:aws:scheduler:${var.region}:${var.account_id}:schedule/${local.production}-cleanup/${local.production}-cleanup",
        "arn:aws:scheduler:${var.region}:${var.account_id}:schedule-group/${local.production}-cleanup"
      ]
    },
    {
      "Sid" : "LogsConfiguration",
      "Effect" : "Allow",
      "Condition" : { "StringEquals" : { "aws:RequestedRegion" : var.region } },
      "Action" : [
        "logs:DescribeLogGroups"
      ],
      "Resource" : [
        "*"
      ]
    },
    {
      "Sid" : "LogTags",
      "Effect" : "Allow",
      "Action" : [
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup"
      ],
      "Resource" : [
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-api",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/apigateway/${local.production}-api",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-cleanup",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-api:*",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/apigateway/${local.production}-api:*",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-cleanup:*"
      ]
    },
    {
      "Sid" : "AlarmConfiguration",
      "Effect" : "Allow",
      "Action" : [
        "cloudwatch:DescribeAlarms",
        "cloudwatch:ListTagsForResource"
      ],
      "Resource" : [
        "arn:aws:cloudwatch:${var.region}:${var.account_id}:alarm:${local.production}-*"
      ]
    }
  ]
  production_write_base = [
    {
      "Sid" : "TableManagement",
      "Effect" : "Allow",
      "Action" : [
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:UpdateContinuousBackups",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:TagResource",
        "dynamodb:UntagResource"
      ],
      "Resource" : [
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-reminders",
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-owner-state",
        "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.production}-image-jobs"
      ]
    },
    {
      "Sid" : "ImageBucketManagement",
      "Effect" : "Allow",
      "Action" : [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketTagging",
        "s3:PutBucketCORS",
        "s3:PutBucketOwnershipControls"
      ],
      "Resource" : [
        "arn:aws:s3:::${var.name_prefix}-${var.account_id}-${var.region}-images"
      ]
    },
    {
      "Sid" : "FunctionManagement",
      "Effect" : "Allow",
      "Action" : [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:PublishVersion",
        "lambda:CreateAlias",
        "lambda:UpdateAlias",
        "lambda:DeleteAlias",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:PutFunctionEventInvokeConfig",
        "lambda:DeleteFunctionEventInvokeConfig",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource" : [
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-api",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-cleanup",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-api:*",
        "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.production}-cleanup:*"
      ]
    },
    {
      "Sid" : "RuntimeRoleManagement",
      "Effect" : "Allow",
      "Action" : [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy"
      ],
      "Resource" : [
        "arn:aws:iam::${var.account_id}:role/${local.production}-api",
        "arn:aws:iam::${var.account_id}:role/${local.production}-cleanup",
        "arn:aws:iam::${var.account_id}:role/${local.production}-scheduler"
      ]
    },
    {
      "Sid" : "PassLambdaRoles",
      "Effect" : "Allow",
      "Action" : [
        "iam:PassRole"
      ],
      "Resource" : [
        "arn:aws:iam::${var.account_id}:role/${local.production}-api",
        "arn:aws:iam::${var.account_id}:role/${local.production}-cleanup"
      ],
      "Condition" : {
        "StringEquals" : {
          "iam:PassedToService" : "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid" : "PassSchedulerRole",
      "Effect" : "Allow",
      "Action" : [
        "iam:PassRole"
      ],
      "Resource" : [
        "arn:aws:iam::${var.account_id}:role/${local.production}-scheduler"
      ],
      "Condition" : {
        "StringEquals" : {
          "iam:PassedToService" : "scheduler.amazonaws.com"
        }
      }
    },
    {
      "Sid" : "CognitoCreation",
      "Effect" : "Allow",
      "Action" : [
        "cognito-idp:CreateUserPool"
      ],
      "Resource" : [
        "*"
      ],
      "Condition" : {
        "StringEquals" : {
          "aws:RequestTag/Project" : "${var.name_prefix}",
          "aws:RequestTag/Environment" : "production",
          "aws:RequestedRegion" : var.region
        }
      }
    },
    {
      "Sid" : "CognitoManagement",
      "Effect" : "Allow",
      "Action" : [
        "cognito-idp:UpdateUserPool",
        "cognito-idp:SetUserPoolMfaConfig",
        "cognito-idp:DeleteUserPool",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:UpdateUserPoolClient",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:CreateUserPoolDomain",
        "cognito-idp:UpdateUserPoolDomain",
        "cognito-idp:DeleteUserPoolDomain",
        "cognito-idp:CreateResourceServer",
        "cognito-idp:UpdateResourceServer",
        "cognito-idp:DeleteResourceServer",
        "cognito-idp:TagResource",
        "cognito-idp:UntagResource"
      ],
      "Resource" : [
        "arn:aws:cognito-idp:${var.region}:${var.account_id}:userpool/*"
      ],
      "Condition" : {
        "StringEquals" : {
          "aws:ResourceTag/Project" : "${var.name_prefix}",
          "aws:ResourceTag/Environment" : "production"
        }
      }
    },
    {
      "Sid" : "SchedulerManagement",
      "Effect" : "Allow",
      "Action" : [
        "scheduler:CreateSchedule",
        "scheduler:CreateScheduleGroup",
        "scheduler:DeleteScheduleGroup",
        "scheduler:TagResource",
        "scheduler:UntagResource",
        "scheduler:UpdateSchedule",
        "scheduler:DeleteSchedule"
      ],
      "Resource" : [
        "arn:aws:scheduler:${var.region}:${var.account_id}:schedule/${local.production}-cleanup/${local.production}-cleanup",
        "arn:aws:scheduler:${var.region}:${var.account_id}:schedule-group/${local.production}-cleanup"
      ]
    },
    {
      "Sid" : "LogManagement",
      "Effect" : "Allow",
      "Action" : [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:TagLogGroup",
        "logs:UntagLogGroup"
      ],
      "Resource" : [
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-api",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/apigateway/${local.production}-api",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-cleanup",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-api:*",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/apigateway/${local.production}-api:*",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-cleanup:*"
      ]
    },
    {
      "Sid" : "AlarmManagement",
      "Effect" : "Allow",
      "Action" : [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource"
      ],
      "Resource" : [
        "arn:aws:cloudwatch:${var.region}:${var.account_id}:alarm:${local.production}-*"
      ]
    }
  ]
  state_list    = { Sid = "StateKeyListing", Effect = "Allow", Action = ["s3:ListBucket"], Resource = [local.bucket_arns.state], Condition = { StringEquals = { "s3:prefix" = local.state_keys } } }
  state_lock    = { Sid = "ProductionStateLocks", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = local.lock_objects }
  artifact_read = { Sid = "ReadReleaseZip", Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = [local.artifact_objects] }
  policies = {
    artifact = concat(local.runtime_ownership_denials, [{ Sid = "RegisterReleaseZip", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"], Resource = [local.artifact_objects] }])
    plan     = concat(local.runtime_ownership_denials, [local.state_list, local.state_lock, local.artifact_read, { Sid = "ReadProductionState", Effect = "Allow", Action = ["s3:GetObject"], Resource = local.state_objects }])
    apply    = concat(local.runtime_ownership_denials, [local.state_list, local.state_lock, local.artifact_read, { Sid = "WriteProductionState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = local.state_objects }], local.production_write)
  }
}
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHub uses AWS's trusted CA library; no manually stale thumbprint.
}
resource "aws_iam_role" "github" {
  for_each             = var.oidc_subjects
  name                 = "${var.name_prefix}-github-${each.key}"
  description          = each.key == "plan" ? "Terraform planning plus production state lock writes" : "Production ${each.key} delivery"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = each.value
      } }
    }]
  })
  depends_on = [aws_iam_openid_connect_provider.github]
}
locals {
  # Identity policy Sids are descriptive only. Omit them to stay below IAM's
  # aggregate inline limit without broadening a single permission/resource.
  policy_text = { for key, statements in local.policies : key => jsonencode({
    Version   = "2012-10-17"
    Statement = [for statement in statements : { for k, v in statement : k => v if k != "Sid" }]
  }) }
}
resource "aws_iam_role_policy" "github" {
  for_each = local.policies
  name     = "production-${each.key}"
  role     = aws_iam_role.github[each.key].id
  policy   = local.policy_text[each.key]
  lifecycle {
    precondition {
      condition     = length(local.policy_text[each.key]) <= 10240
      error_message = "Scoped role policy exceeds IAM's inline limit; do not replace scopes with wildcards."
    }
  }
}

resource "aws_iam_policy" "production_read" {
  name        = "${var.name_prefix}-github-production-read"
  description = "Scoped infrastructure configuration reads; no runtime data or Cognito users"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [for statement in local.production_read : { for k, v in statement : k => v if k != "Sid" }]
  })
  lifecycle {
    precondition {
      condition     = length(jsonencode({ Version = "2012-10-17", Statement = [for statement in local.production_read : { for k, v in statement : k => v if k != "Sid" }] })) <= 6144
      error_message = "Scoped read policy exceeds IAM's managed policy limit."
    }
  }
}
resource "aws_iam_role_policy_attachment" "production_read" {
  for_each   = toset(["plan", "apply"])
  role       = aws_iam_role.github[each.key].name
  policy_arn = aws_iam_policy.production_read.arn
}
