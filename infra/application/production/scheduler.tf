# Bootstrap alone owns Scheduler trust, SourceAccount and exact group SourceArn.
# The dedicated deterministic group below matches that reviewed producer.
resource "aws_scheduler_schedule_group" "cleanup" {
  name = "${local.production}-cleanup"
}
resource "aws_iam_role_policy" "scheduler" {
  name = "${local.production}-cleanup-invoke"
  role = "${local.production}-scheduler"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_alias.cleanup.arn]
    }]
  })
}
resource "aws_scheduler_schedule" "cleanup" {
  name                         = "${local.production}-cleanup"
  group_name                   = aws_scheduler_schedule_group.cleanup.name
  schedule_expression          = "cron(0 3 * * ? *)"
  schedule_expression_timezone = "UTC"
  state                        = var.scheduler_enabled ? "ENABLED" : "DISABLED"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_alias.cleanup.arn
    role_arn = var.scheduler_role_arn
    input    = jsonencode({})
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
  depends_on = [aws_iam_role_policy.scheduler, aws_lambda_function_event_invoke_config.cleanup]
}
