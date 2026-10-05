resource "aws_apigatewayv2_api" "production" {
  name                         = "${local.production}-api"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = false
  cors_configuration {
    allow_origins     = [var.chrome_origin]
    allow_methods     = ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"]
    allow_headers     = ["authorization", "content-type", "if-match"]
    expose_headers    = ["ETag", "Location", "X-Request-Id", "Retry-After", "Allow"]
    allow_credentials = false
  }
  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = var.operator_api_seed || self.id == var.production_api_id
      error_message = "Normal releases must retain the API ID registered with bootstrap; absent/mismatched API state cannot silently reseed."
    }
  }
}
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.production.id
  name             = "${local.production}-cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = var.cognito_issuer
    audience = [var.cognito_client_id]
  }
}
resource "aws_lambda_permission" "gateway" {
  statement_id   = "ProductionGatewayOnly"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.api.function_name
  qualifier      = aws_lambda_alias.api.name
  principal      = "apigateway.amazonaws.com"
  source_account = var.account_id
  source_arn     = "${aws_apigatewayv2_api.production.execution_arn}/$default/*/*"
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.production.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_alias.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
  depends_on             = [aws_lambda_permission.gateway]
}
locals {
  route_scopes = {
    "ANY /healthz"                         = null
    "ANY /readyz"                          = null
    "ANY /reminders"                       = null
    "ANY /v2/reminders"                    = null
    "ANY /v2/reminders/{id}"               = null
    "ANY /v2/reminders/{id}/thumbnail-url" = null
    "GET /healthz"                         = null
    "GET /readyz"                          = null
    "POST /reminders"                      = null
    "PUT /reminders"                       = null
    "GET /v2/reminders"                    = "reminder-api/read"
    "POST /v2/reminders"                   = "reminder-api/write"
    "GET /v2/reminders/{id}"               = "reminder-api/read"
    "PATCH /v2/reminders/{id}"             = "reminder-api/write"
    "DELETE /v2/reminders/{id}"            = "reminder-api/write"
    "GET /v2/reminders/{id}/thumbnail-url" = "reminder-api/read"
  }
}
resource "aws_apigatewayv2_route" "api" {
  for_each             = local.route_scopes
  api_id               = aws_apigatewayv2_api.production.id
  route_key            = each.key
  target               = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type   = each.value == null ? "NONE" : "JWT"
  authorizer_id        = each.value == null ? null : aws_apigatewayv2_authorizer.cognito.id
  authorization_scopes = each.value == null ? [] : [each.value]
}
# Finite unauthenticated ANY routes classify unsupported methods only; explicit
# CRUD routes retain JWT/scopes. Gateway configured CORS owns preflight OPTIONS.
# Do not add a JWT $default route, which would catch OPTIONS.
resource "aws_apigatewayv2_stage" "production" {
  api_id      = aws_apigatewayv2_api.production.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = "arn:aws:logs:${var.region}:${var.account_id}:log-group:${var.gateway_log_group}"
    format = jsonencode({
      requestId      = "$context.requestId"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
    })
  }
  default_route_settings {
    detailed_metrics_enabled = false
    throttling_rate_limit    = 20
    throttling_burst_limit   = 40
  }
  lifecycle { prevent_destroy = true }
}
