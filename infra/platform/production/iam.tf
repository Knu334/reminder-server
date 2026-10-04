# Bootstrap alone creates roles, trusts and immutable permission ceilings.
# These inline grants authorize only the existing runtime SDK operations.
# Transaction Put/Update use PutItem/UpdateItem (there is no transaction IAM action):
# https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html
# HeadBucket => ListBucket; unversioned HEAD => GetObject; pinned GET => GetObjectVersion:
# https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html
locals {
  runtime_log_arns = { for key in ["api", "cleanup"] : key => "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.production}-${key}:*" }
}
resource "aws_iam_role_policy" "api" {
  name = "${local.production}-api-runtime"
  role = basename(var.api_role_arn)
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = values(local.table_arns) },
      { Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = [local.table_arns.reminders, local.table_arns.image_jobs] },
      { Effect = "Allow", Action = ["dynamodb:UpdateItem"], Resource = [local.table_arns.owner_state, local.table_arns.image_jobs] },
      { Effect = "Allow", Action = ["dynamodb:Query"], Resource = [local.table_arns.reminders] },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = [local.images_bucket_arn] },
      # The bootstrap ceiling independently bounds browser-consumed SigV4
      # version reads to query authentication and signature age <=900000ms.
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], Resource = ["${local.images_bucket_arn}/images/*"] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [local.runtime_log_arns.api] }
    ]
  })
}
resource "aws_iam_role_policy" "cleanup" {
  name = "${local.production}-cleanup-runtime"
  role = basename(var.cleanup_role_arn)
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = [local.table_arns.owner_state, local.table_arns.image_jobs] },
      { Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = [local.table_arns.image_jobs] },
      { Effect = "Allow", Action = ["dynamodb:Query"], Resource = ["${local.table_arns.image_jobs}/index/cleanup_by_due"] },
      # ListBucket lets a missing-key HEAD return 404 rather than 403.
      # No prefix condition: HeadObject does not carry a ListObjects prefix.
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = [local.images_bucket_arn] },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = ["${local.images_bucket_arn}/images/*"] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [local.runtime_log_arns.cleanup] },
      { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = ["*"], Condition = { StringEquals = { "cloudwatch:namespace" = "ReminderServer", "aws:RequestedRegion" = var.region } } }
    ]
  })
}
# Migration/recovery needs separately authorized short-lived operator permissions
# (including private owner_state markers). Runtime and GHA grants exclude them;
# operator procedures are documented by the later operations-documentation task.
