resource "aws_cloudwatch_log_group" "runtime" {
  for_each          = toset(["api", "cleanup"])
  name              = "/aws/lambda/${local.production}-${each.key}"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/aws/apigateway/${local.production}-api"
  retention_in_days = 30
}
