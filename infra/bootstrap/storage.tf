locals {
  buckets = {
    state     = "${var.name_prefix}-${var.account_id}-${var.region}-state"
    artifacts = "${var.name_prefix}-${var.account_id}-${var.region}-artifacts"
  }
  bucket_arns      = { for k, name in local.buckets : k => "arn:aws:s3:::${name}" }
  artifact_objects = "${local.bucket_arns.artifacts}/releases/*/reminder-server.zip"
}
resource "aws_s3_bucket" "state" {
  bucket        = local.buckets.state
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "artifacts" {
  bucket        = local.buckets.artifacts
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "private" {
  for_each = local.buckets
  bucket   = each.key == "state" ? aws_s3_bucket.state.id : aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  for_each = local.buckets
  bucket   = each.key == "state" ? aws_s3_bucket.state.id : aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "private" {
  for_each                = local.buckets
  bucket                  = each.key == "state" ? aws_s3_bucket.state.id : aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "private" {
  for_each   = local.buckets
  bucket     = each.key == "state" ? aws_s3_bucket.state.id : aws_s3_bucket.artifacts.id
  depends_on = [aws_s3_bucket_public_access_block.private]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [local.bucket_arns[each.key], "${local.bucket_arns[each.key]}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }], [for statement in [{
        Sid       = "RequireCreateOnlyWrite"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.bucket_arns.artifacts}/*"
        Condition = { StringNotEquals = { "s3:if-none-match" = "*" } }
        }, {
        Sid       = "RetainReleaseVersions"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${local.bucket_arns.artifacts}/*"
    }] : statement if each.key == "artifacts"])
  })
}
