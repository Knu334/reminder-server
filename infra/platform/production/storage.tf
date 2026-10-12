locals {
  tables = {
    reminders   = { suffix = "reminders", hash = "ownerId", range = "id", attributes = ["ownerId", "id"] }
    owner_state = { suffix = "owner-state", hash = "pk", range = "sk", attributes = ["pk", "sk"] }
    image_jobs  = { suffix = "image-jobs", hash = "jobId", range = null, attributes = ["jobId", "cleanupPartition", "cleanupSortKey"] }
  }
  selected_table_names = { for key, table in local.tables : key => lookup(var.restored_tables, key, "${local.production}-${table.suffix}") }
  table_arns           = { for key, name in local.selected_table_names : key => "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${name}" }
  images_bucket_name   = "${var.name_prefix}-${var.account_id}-${var.region}-images"
  images_bucket_arn    = "arn:aws:s3:::${local.images_bucket_name}"
}
resource "aws_dynamodb_table" "runtime" {
  for_each                    = local.tables
  name                        = "${local.production}-${each.value.suffix}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = each.value.hash
  range_key                   = each.value.range
  deletion_protection_enabled = true
  dynamic "attribute" {
    for_each = each.value.attributes
    content {
      name = attribute.value
      type = "S"
    }
  }
  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = 35
  }
  dynamic "ttl" {
    for_each = each.key == "owner_state" ? [true] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }
  dynamic "global_secondary_index" {
    for_each = each.key == "image_jobs" ? [true] : []
    content {
      name            = "cleanup_by_due"
      projection_type = "KEYS_ONLY"
      key_schema {
        attribute_name = "cleanupPartition"
        key_type       = "HASH"
      }
      key_schema {
        attribute_name = "cleanupSortKey"
        key_type       = "RANGE"
      }
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "images" {
  bucket        = local.images_bucket_name
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "images" {
  bucket     = aws_s3_bucket.images.id
  depends_on = [aws_s3_bucket_public_access_block.images]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:*"]
      Resource  = [local.images_bucket_arn, "${local.images_bucket_arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket     = aws_s3_bucket.images.id
  depends_on = [aws_s3_bucket_versioning.images]
  rule {
    id     = "retain-noncurrent-images-60-days"
    status = "Enabled"
    filter { prefix = "images/" }
    noncurrent_version_expiration { noncurrent_days = 60 }
  }
}
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  cors_rule {
    allowed_origins = [var.chrome_origin]
    allowed_methods = ["GET", "HEAD"]
  }
}

# Restores stay operator-owned. Read and verify, never import/adopt or replace originals.
data "aws_dynamodb_table" "restored" {
  for_each = var.restored_tables
  name     = each.value
  lifecycle {
    postcondition {
      condition = (
        self.arn == local.table_arns[each.key] && self.name == each.value &&
        self.deletion_protection_enabled && self.billing_mode == "PAY_PER_REQUEST" &&
        self.hash_key == local.tables[each.key].hash &&
        coalesce(self.range_key, "none") == coalesce(local.tables[each.key].range, "none") &&
        toset([for attribute in self.attribute : "${attribute.name}:${attribute.type}"]) == toset([for name in local.tables[each.key].attributes : "${name}:S"]) &&
        try(self.point_in_time_recovery[0].enabled && self.point_in_time_recovery[0].recovery_period_in_days == 35, false) &&
        (each.key != "owner_state" || anytrue([for ttl in self.ttl : ttl.enabled && ttl.attribute_name == "expiresAt"])) &&
        (each.key != "image_jobs" || anytrue([for index in self.global_secondary_index : index.name == "cleanup_by_due" && index.projection_type == "KEYS_ONLY" && index.hash_key == "cleanupPartition" && index.range_key == "cleanupSortKey"]))
      )
      error_message = "Restored table must match exact account/region identity, runtime keys/index, on-demand billing, deletion protection, 35-day PITR and owner TTL before handoff."
    }
  }
}
