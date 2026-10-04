locals {
  # Exact metric producer names and dimensions, with no route-level detail/SNS.
  alarms = {
    gateway_5xx           = { namespace = "AWS/ApiGateway", metric = "5xx", dimensions = { ApiId = aws_apigatewayv2_api.production.id } }
    api_errors            = { namespace = "AWS/Lambda", metric = "Errors", dimensions = { FunctionName = aws_lambda_function.api.function_name } }
    api_throttles         = { namespace = "AWS/Lambda", metric = "Throttles", dimensions = { FunctionName = aws_lambda_function.api.function_name } }
    api_duration          = { namespace = "AWS/Lambda", metric = "Duration", dimensions = { FunctionName = aws_lambda_function.api.function_name } }
    cleanup_errors        = { namespace = "AWS/Lambda", metric = "Errors", dimensions = { FunctionName = aws_lambda_function.cleanup.function_name } }
    cleanup_async_dropped = { namespace = "AWS/Lambda", metric = "AsyncEventsDropped", dimensions = { FunctionName = aws_lambda_function.cleanup.function_name } }
    cleanup_incomplete    = { namespace = "ReminderServer", metric = "CleanupIncomplete", dimensions = { Environment = "production" } }
    scheduler_dropped     = { namespace = "AWS/Scheduler", metric = "InvocationDroppedCount", dimensions = { ScheduleGroup = aws_scheduler_schedule_group.cleanup.name } }
    cleanup_heartbeat     = { namespace = "ReminderServer", metric = "CleanupHeartbeat", dimensions = { Environment = "production" } }
  }
}
resource "aws_cloudwatch_metric_alarm" "production" {
  for_each                              = local.alarms
  alarm_name                            = "${local.production}-${replace(each.key, "_", "-")}"
  namespace                             = each.value.namespace
  metric_name                           = each.value.metric
  dimensions                            = each.value.dimensions
  comparison_operator                   = each.key == "api_duration" ? "GreaterThanThreshold" : each.key == "cleanup_heartbeat" ? "LessThanThreshold" : "GreaterThanOrEqualToThreshold"
  threshold                             = each.key == "api_duration" ? 2000 : 1
  period                                = each.key == "cleanup_heartbeat" ? 86400 : each.key == "cleanup_incomplete" ? 3600 : 300
  evaluation_periods                    = each.key == "api_duration" ? 2 : 1
  statistic                             = each.key == "api_duration" ? null : each.key == "cleanup_incomplete" ? "Maximum" : "Sum"
  extended_statistic                    = each.key == "api_duration" ? "p95" : null
  evaluate_low_sample_count_percentiles = each.key == "api_duration" ? "ignore" : null
  treat_missing_data                    = each.key == "cleanup_heartbeat" && var.scheduler_enabled ? "breaching" : "notBreaching"
  actions_enabled                       = each.key == "cleanup_heartbeat" ? var.scheduler_enabled : true
  alarm_description                     = each.key == "cleanup_heartbeat" ? "Missing heartbeat evaluation is inactive before public operation: Scheduler disabled, actions disabled and missing data not breaching. Publication enables breaching evaluation with Scheduler." : "Production ${each.value.metric} threshold."
}
