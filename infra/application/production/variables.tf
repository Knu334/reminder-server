variable "account_id" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be an explicit 12-digit AWS account ID."
  }
}
variable "region" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[1-9][0-9]*$", var.region)) && !startswith(var.region, "cn-")
    error_message = "region must be an explicit commercial AWS region."
  }
}
variable "name_prefix" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}[a-z0-9]$", var.name_prefix)) && !strcontains(var.name_prefix, "--") && length("${var.name_prefix}-${var.account_id}-${var.region}-images") <= 63
    error_message = "Use the bootstrap lowercase 3-26 character name_prefix and valid derived bucket names."
  }
}
variable "chrome_origin" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^(chrome-extension://[a-p]{32}|https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?)$", var.chrome_origin)) && !strcontains(var.chrome_origin, "..")
    error_message = "chrome_origin must be one exact Chrome extension or HTTPS origin, without path, wildcard, fragment or credentials."
  }
}
variable "production_api_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Explicit bootstrap production_api_id handoff. Null is permitted only for exceptional operator API-only seed."
  validation {
    condition     = var.operator_api_seed ? var.production_api_id == null : (var.production_api_id == null ? false : can(regex("^[a-z0-9]{10}$", var.production_api_id)))
    error_message = "Normal releases require a nonnull production_api_id; only explicit operator_api_seed may omit it."
  }
}
variable "operator_api_seed" {
  type        = bool
  default     = false
  nullable    = false
  description = "Exceptional operator-only API preparation; never enabled by GHA. Target aws_apigatewayv2_api.production only."
  validation {
    condition     = !var.operator_api_seed || !var.scheduler_enabled
    error_message = "Operator seed requires absent production_api_id and disabled Scheduler, and cannot reseed a registered API."
  }
}
variable "scheduler_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Public operation flag; enables daily cleanup and missing heartbeat evaluation together."
}
variable "api_role_arn" {
  type     = string
  nullable = false
  validation {
    condition     = var.api_role_arn == "arn:aws:iam::${var.account_id}:role/${var.name_prefix}-production-api"
    error_message = "api_role_arn must reference the existing exact bootstrap API role."
  }
}
variable "cleanup_role_arn" {
  type     = string
  nullable = false
  validation {
    condition     = var.cleanup_role_arn == "arn:aws:iam::${var.account_id}:role/${var.name_prefix}-production-cleanup"
    error_message = "cleanup_role_arn must reference the existing exact bootstrap cleanup role."
  }
}
variable "scheduler_role_arn" {
  type     = string
  nullable = false
  validation {
    condition     = var.scheduler_role_arn == "arn:aws:iam::${var.account_id}:role/${var.name_prefix}-production-scheduler"
    error_message = "scheduler_role_arn must reference the existing exact bootstrap Scheduler role with group-scoped trust."
  }
}
variable "reminders_table" {
  type     = string
  nullable = false
  validation {
    condition     = var.reminders_table == "${var.name_prefix}-production-reminders"
    error_message = "reminders_table must match the exact platform output."
  }
}
variable "owner_state_table" {
  type     = string
  nullable = false
  validation {
    condition     = var.owner_state_table == "${var.name_prefix}-production-owner-state"
    error_message = "owner_state_table must match the exact platform output."
  }
}
variable "image_jobs_table" {
  type     = string
  nullable = false
  validation {
    condition     = var.image_jobs_table == "${var.name_prefix}-production-image-jobs"
    error_message = "image_jobs_table must match the exact platform output."
  }
}
variable "images_bucket" {
  type     = string
  nullable = false
  validation {
    condition     = var.images_bucket == "${var.name_prefix}-${var.account_id}-${var.region}-images"
    error_message = "images_bucket must match the exact platform output."
  }
}
variable "api_log_group" {
  type     = string
  nullable = false
  validation {
    condition     = var.api_log_group == "/aws/lambda/${var.name_prefix}-production-api"
    error_message = "api_log_group must be the platform-owned API log group."
  }
}
variable "cleanup_log_group" {
  type     = string
  nullable = false
  validation {
    condition     = var.cleanup_log_group == "/aws/lambda/${var.name_prefix}-production-cleanup"
    error_message = "cleanup_log_group must be the platform-owned cleanup log group."
  }
}
variable "gateway_log_group" {
  type     = string
  nullable = false
  validation {
    condition     = var.gateway_log_group == "/aws/apigateway/${var.name_prefix}-production-api"
    error_message = "gateway_log_group must be the platform-owned Gateway log group."
  }
}
variable "cognito_issuer" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^https://cognito-idp\\.${var.region}\\.amazonaws\\.com/${var.region}_[A-Za-z0-9]+$", var.cognito_issuer))
    error_message = "cognito_issuer must be the exact platform issuer in the selected region."
  }
}
variable "cognito_client_id" {
  type     = string
  nullable = false
  validation {
    condition     = can(regex("^[a-z0-9]{1,128}$", var.cognito_client_id))
    error_message = "cognito_client_id must be an explicit public platform client ID."
  }
}
variable "cognito_auth_base_url" {
  type        = string
  nullable    = false
  description = "Platform Hosted UI output carried in the input contract for publication; not a Lambda runtime environment variable."
  validation {
    condition     = can(regex("^https://[a-z0-9][a-z0-9-]*\\.auth\\.${var.region}\\.amazoncognito\\.com$", var.cognito_auth_base_url))
    error_message = "cognito_auth_base_url must be the explicit platform Hosted UI URL in this region."
  }
}
variable "artifact" {
  type = object({
    bucket        = string
    key           = string
    version_id    = string
    sha256_base64 = string
  })
  nullable    = false
  description = "D02 RegisteredArtifact mapping: bucket/key/versionId/sha256Base64. Registration validates key-to-hex/base64 identity; Lambda postconditions verify AWS CodeSha256."
  validation {
    condition     = var.artifact.bucket == "${var.name_prefix}-${var.account_id}-${var.region}-artifacts" && can(regex("^releases/[0-9a-f]{64}/reminder-server\\.zip$", var.artifact.key)) && can(regex("^[A-Za-z0-9+/]{43}=$", var.artifact.sha256_base64)) && length(var.artifact.version_id) > 0 && length(var.artifact.version_id) <= 1024 && var.artifact.version_id != "null" && trimspace(var.artifact.version_id) == var.artifact.version_id
    error_message = "artifact requires the bootstrap artifact bucket, immutable release key, nonnull exact version ID and SHA-256 Base64."
  }
}
variable "allowed_source_ips" {
  type        = list(string)
  default     = null
  description = "Optional literal IPs, JSON encoded for runtime. Null omits ALLOWED_SOURCE_IPS; empty allows all. No CIDRs/hosts."
  validation {
    condition     = var.allowed_source_ips == null ? true : alltrue([for ip in var.allowed_source_ips : try(!strcontains(ip, "/") && can(cidrhost("${ip}/${strcontains(ip, ":") ? 128 : 32}", 0)) && trimspace(ip) == ip && (!strcontains(ip, ".") || can(regex("(^|:)(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})$", ip))), false)])
    error_message = "allowed_source_ips accepts literal IPv4/IPv6 addresses only."
  }
}
variable "runtime_limits" {
  type        = map(number)
  default     = {}
  nullable    = false
  description = "Optional loadConfig limit overrides, each positive safe integer; defaults stay owned by runtime. Higher/lower limits are supported."
  validation {
    condition     = alltrue([for key, value in var.runtime_limits : contains(["MAX_JSON_BYTES", "MAX_THUMBNAIL_BYTES", "MAX_OWNER_ITEMS", "MAX_OWNER_IMAGE_BYTES", "OWNER_REQUESTS_PER_MINUTE"], key) && value != null && try(value >= 1 && value <= 9007199254740991 && floor(value) == value, false)])
    error_message = "runtime_limits must contain only supported environment keys with positive JavaScript-safe integer values."
  }
}

locals {
  production = "${var.name_prefix}-production"
  runtime_environment = merge({
    REMINDERS_TABLE                                               = var.reminders_table
    OWNER_STATE_TABLE                                             = var.owner_state_table
    IMAGE_JOBS_TABLE                                              = var.image_jobs_table
    IMAGES_BUCKET                                                 = var.images_bucket
    EXPECTED_API_ID                                               = aws_apigatewayv2_api.production.id
    EXPECTED_API_STAGE                                            = "$default"
    COGNITO_ISSUER                                                = var.cognito_issuer
    COGNITO_CLIENT_ID                                             = var.cognito_client_id
    }, var.allowed_source_ips == null ? {} : { ALLOWED_SOURCE_IPS = jsonencode(var.allowed_source_ips) }, {
    for key, value in var.runtime_limits : key => tostring(value)
  })
}
