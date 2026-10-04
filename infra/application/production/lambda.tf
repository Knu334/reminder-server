resource "aws_lambda_function" "api" {
  function_name                  = "${local.production}-api"
  role                           = var.api_role_arn
  package_type                   = "Zip"
  runtime                        = "nodejs24.x"
  architectures                  = ["x86_64"]
  handler                        = "dist/api.handler"
  memory_size                    = 512
  timeout                        = 10
  reserved_concurrent_executions = 10
  s3_bucket                      = var.artifact.bucket
  s3_key                         = var.artifact.key
  s3_object_version              = var.artifact.version_id
  source_code_hash               = var.artifact.sha256_base64
  publish                        = true
  environment { variables = local.runtime_environment }
  logging_config {
    log_format = "Text"
    log_group  = var.api_log_group
  }
  lifecycle {
    precondition {
      condition     = !var.operator_api_seed
      error_message = "Operator preparation must target aws_apigatewayv2_api.production only; full application deployment requires the registered API ID."
    }
    postcondition {
      condition     = self.code_sha256 == var.artifact.sha256_base64
      error_message = "AWS API Lambda CodeSha256 must equal the registered immutable ZIP digest."
    }
  }
}
resource "aws_lambda_function" "cleanup" {
  function_name                  = "${local.production}-cleanup"
  role                           = var.cleanup_role_arn
  package_type                   = "Zip"
  runtime                        = "nodejs24.x"
  architectures                  = ["x86_64"]
  handler                        = "dist/cleanup.handler"
  memory_size                    = 512
  timeout                        = 660
  reserved_concurrent_executions = 1
  s3_bucket                      = var.artifact.bucket
  s3_key                         = var.artifact.key
  s3_object_version              = var.artifact.version_id
  source_code_hash               = var.artifact.sha256_base64
  publish                        = true
  environment { variables = local.runtime_environment }
  logging_config {
    log_format = "Text"
    log_group  = var.cleanup_log_group
  }
  lifecycle {
    precondition {
      condition     = !var.operator_api_seed
      error_message = "Operator preparation must target aws_apigatewayv2_api.production only; full application deployment requires the registered API ID."
    }
    postcondition {
      condition     = self.code_sha256 == var.artifact.sha256_base64
      error_message = "AWS cleanup Lambda CodeSha256 must equal the registered immutable ZIP digest."
    }
  }
}
resource "aws_lambda_alias" "api" {
  name             = "production"
  function_name    = aws_lambda_function.api.function_name
  function_version = aws_lambda_function.api.version
}
resource "aws_lambda_alias" "cleanup" {
  name             = "production"
  function_name    = aws_lambda_function.cleanup.function_name
  function_version = aws_lambda_function.cleanup.version
}
resource "aws_lambda_function_event_invoke_config" "cleanup" {
  function_name                = aws_lambda_function.cleanup.function_name
  qualifier                    = aws_lambda_alias.cleanup.name
  maximum_event_age_in_seconds = 3600
  maximum_retry_attempts       = 2
}
# No Function URL. API direct invocation is granted only to the exact Gateway
# stage below; Scheduler assumes its existing bootstrap-owned scoped role.
