variable "account_id" {
  type        = string
  nullable    = false
  description = "Explicit commercial AWS account, enforced by the provider."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit account ID."
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
    error_message = "Use the bootstrap 3-26 character lowercase name_prefix, producing a bucket name of at most 63 characters."
  }
}
variable "chrome_origin" {
  type        = string
  nullable    = false
  description = "Exact production Chrome extension or HTTPS origin; no paths, wildcards or credentials."
  validation {
    condition     = can(regex("^(chrome-extension://[a-p]{32}|https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?)$", var.chrome_origin)) && !strcontains(var.chrome_origin, "..")
    error_message = "chrome_origin must be one complete Chrome extension or HTTPS origin without a trailing slash, path, wildcard, fragment or credentials."
  }
}
variable "callback_url" {
  type        = string
  nullable    = false
  description = "Exact full production OAuth callback URL, including path. PKCE S256 is supplied by the extension."
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/[^*# \t\r\n]*$", var.callback_url)) && !strcontains(var.callback_url, "..")
    error_message = "callback_url must be one full HTTPS URL with path and no wildcard, fragment, whitespace or credentials."
  }
}
variable "logout_url" {
  type        = string
  nullable    = false
  description = "Exact full production Hosted UI logout redirect URL, including path."
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/[^*# \t\r\n]*$", var.logout_url)) && !strcontains(var.logout_url, "..")
    error_message = "logout_url must be one full HTTPS URL with path and no wildcard, fragment, whitespace or credentials."
  }
}
variable "cognito_domain_prefix" {
  type        = string
  nullable    = false
  description = "Explicit unique Cognito hosted-domain prefix; no inferred account/domain values."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.cognito_domain_prefix)) && !can(regex("(aws|amazon|cognito)", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be 1-63 lowercase alphanumeric/hyphen characters without reserved aws, amazon or cognito text."
  }
}
variable "api_role_arn" {
  type        = string
  nullable    = false
  description = "Bootstrap api_role_arn output; bootstrap owns role/trust and immutable ceiling."
  validation {
    condition     = var.api_role_arn == "arn:aws:iam::${var.account_id}:role/${var.name_prefix}-production-api"
    error_message = "api_role_arn must be the exact bootstrap API role in this account/name_prefix."
  }
}
variable "cleanup_role_arn" {
  type        = string
  nullable    = false
  description = "Bootstrap cleanup_role_arn output; bootstrap owns role/trust and immutable ceiling."
  validation {
    condition     = var.cleanup_role_arn == "arn:aws:iam::${var.account_id}:role/${var.name_prefix}-production-cleanup"
    error_message = "cleanup_role_arn must be the exact bootstrap cleanup role in this account/name_prefix."
  }
}

locals {
  production = "${var.name_prefix}-production"
}

variable "restored_tables" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Exceptional reviewed same-account/region PITR set. Empty selects originals; otherwise exactly three disjoint names, maximum 64 chars for bounded IAM policies. Bootstrap must select the identical set first."
  validation {
    condition = length(var.restored_tables) == 0 || (
      toset(keys(var.restored_tables)) == toset(["reminders", "owner_state", "image_jobs"]) &&
      length(toset(values(var.restored_tables))) == 3 &&
      alltrue([for name in values(var.restored_tables) : can(regex("^[A-Za-z0-9_.-]{3,64}$", name)) && !contains(["${var.name_prefix}-production-reminders", "${var.name_prefix}-production-owner-state", "${var.name_prefix}-production-image-jobs"], name)])
    )
    error_message = "restored_tables must be empty or exactly three valid distinct names disjoint from every original production table."
  }
}
