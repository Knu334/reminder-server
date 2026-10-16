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

# release custody: plan・入力・証拠・結果・診断を、run をまたいで受け渡す private な bucket。
# 既存の local.buckets の for_each の key を変えないため、別のリソースとして書く。
locals {
  custody_bucket = "${var.name_prefix}-${var.account_id}-${var.region}-custody"
  custody_arn    = "arn:aws:s3:::${local.custody_bucket}"
  # prefix ごとの現行の version の失効の日数。prefix は互いに重ならない。
  custody_expiration_days = {
    "registered-release"  = 1
    "release-review"      = 1
    "failure-diagnostics" = 1
    "release-result"      = 30
  }
  custody_objects = { for prefix in keys(local.custody_expiration_days) : prefix => "${local.custody_arn}/${prefix}/*" }
}
resource "aws_s3_bucket" "custody" {
  bucket        = local.custody_bucket
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "custody" {
  bucket = aws_s3_bucket.custody.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "custody" {
  bucket = aws_s3_bucket.custody.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "custody" {
  bucket                  = aws_s3_bucket.custody.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "custody" {
  bucket     = aws_s3_bucket.custody.id
  depends_on = [aws_s3_bucket_public_access_block.custody]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [local.custody_arn, "${local.custody_arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }, {
      # If-None-Match: * の無い書き込み（既存の object の上書き）を拒否する。
      Sid       = "RequireCreateOnlyWrite"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "${local.custody_arn}/*"
      Condition = { StringNotEquals = { "s3:if-none-match" = "*" } }
      }, {
      # object を消すのは lifecycle だけとする（lifecycle の削除は bucket policy の拒否を受けない）。
      Sid       = "DenyCustodyDeletion"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
      Resource  = "${local.custody_arn}/*"
    }]
  })
}
resource "aws_s3_bucket_lifecycle_configuration" "custody" {
  bucket = aws_s3_bucket.custody.id
  # versioning の有効化の後に、古い version の規則を置く。
  depends_on = [aws_s3_bucket_versioning.custody]
  dynamic "rule" {
    for_each = local.custody_expiration_days
    content {
      id     = rule.key
      status = "Enabled"
      filter { prefix = "${rule.key}/" }
      expiration { days = rule.value }
      noncurrent_version_expiration { noncurrent_days = 1 }
    }
  }
  # ExpiredObjectDeleteMarker は Days と同じ規則に書けないため、別の規則にする。
  rule {
    id     = "expired-delete-markers"
    status = "Enabled"
    filter {}
    expiration { expired_object_delete_marker = true }
  }
}
