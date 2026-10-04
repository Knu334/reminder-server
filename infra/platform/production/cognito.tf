# Users are provisioned only by the authorized operator in Cognito's console;
# no user resources, passwords or tokens enter Terraform state.
resource "aws_cognito_user_pool" "production" {
  name                = local.production
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = "ACTIVE"
  admin_create_user_config { allow_admin_create_user_only = true }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
  schema {
    name                = "email"
    attribute_data_type = "String"
    mutable             = true
    required            = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_resource_server" "api" {
  name         = "Reminder API"
  identifier   = "reminder-api"
  user_pool_id = aws_cognito_user_pool.production.id
  scope {
    scope_name        = "read"
    scope_description = "Read the signed-in owner's reminders and images"
  }
  scope {
    scope_name        = "write"
    scope_description = "Write the signed-in owner's reminders and images"
  }
}
resource "aws_cognito_user_pool_client" "chrome" {
  name                                 = "${local.production}-chrome"
  user_pool_id                         = aws_cognito_user_pool.production.id
  generate_secret                      = false
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "reminder-api/read", "reminder-api/write"]
  callback_urls                        = [var.callback_url]
  logout_urls                          = [var.logout_url]
  # Keep only an IAM-authorized residual API flow, without any corresponding
  # runtime/GHA permission or caller. Public API sign-in would issue the
  # self-administration scope independently of the OAuth scope allowlist.
  # A nonempty set also avoids default public flows and legacy refresh auth.
  # Classic Hosted UI uses authorization code + caller-supplied PKCE S256.
  # https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html
  explicit_auth_flows           = ["ALLOW_ADMIN_USER_PASSWORD_AUTH"]
  read_attributes               = ["email"]
  write_attributes              = ["email"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 5
  id_token_validity             = 5
  refresh_token_validity        = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 10
  }
  depends_on = [aws_cognito_resource_server.api]
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_user_pool_domain" "production" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.production.id
  # Classic Hosted UI needs no separately managed branding resource.
  managed_login_version = 1
}
