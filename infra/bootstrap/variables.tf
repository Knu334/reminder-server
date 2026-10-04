variable "account_id" {
  type        = string
  description = "Explicit AWS account; also enforced by the provider."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit account ID."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[1-9][0-9]*$", var.region)) && !startswith(var.region, "cn-")
    error_message = "region must be an explicit commercial AWS region; other partitions need explicit ARN support."
  }
}
variable "repository" {
  type        = string
  description = "Exact GitHub owner/repository, never inferred."
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "repository must be an explicit owner/repository."
  }
}
variable "github_environment" {
  type        = string
  description = "Production GitHub environment, matching its actual OIDC subject."
  validation {
    condition     = var.github_environment == "production"
    error_message = "The only permanent environment is production."
  }
}
variable "oidc_subjects" {
  type        = object({ artifact = string, plan = string, apply = string })
  description = "Actual exact sub for each AWS job; no default or wildcard. Environment colons are percent-encoded by GitHub."
  validation {
    condition     = alltrue([for sub in values(var.oidc_subjects) : length(sub) > 0 && !strcontains(sub, "*") && !strcontains(sub, "?") && startswith(sub, "repo:${var.repository}:") && (sub == "repo:${var.repository}:environment:${replace(var.github_environment, ":", "%3A")}" || can(regex("^repo:[^:]+/[^:]+:ref:refs/(heads|tags)/[^*? \n]+$", sub)))])
    error_message = "Supply each actual exact repository branch/tag or production environment OIDC subject; wildcards and empty subjects are forbidden."
  }
}
variable "name_prefix" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}[a-z0-9]$", var.name_prefix)) && !strcontains(var.name_prefix, "--") && length("${var.name_prefix}-${var.account_id}-${var.region}-artifacts") <= 63
    error_message = "name_prefix must be 3-26 lowercase letters/digits/hyphens, beginning with a letter, ending alphanumeric, without double hyphens, and produce a bucket name of at most 63 characters."
  }
}

variable "production_api_id" {
  type        = string
  nullable    = true
  default     = null
  description = "Known production HTTP API ID from the separately authorized application-root first seed. Null grants no HTTP API management to GitHub."
  validation {
    condition     = var.production_api_id == null || can(regex("^[a-z0-9]{1,32}$", var.production_api_id))
    error_message = "production_api_id must be null or an explicit lowercase alphanumeric API ID; no paths, wildcards or whitespace."
  }
}
