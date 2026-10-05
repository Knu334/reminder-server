output "api_base_url" { value = aws_apigatewayv2_api.production.api_endpoint }
output "api_id" {
  value       = aws_apigatewayv2_api.production.id
  description = "Operator API-only seed output returned to bootstrap production_api_id; normal release retains this ID."
}
output "api_alias_arn" { value = aws_lambda_alias.api.arn }
output "cleanup_alias_arn" { value = aws_lambda_alias.cleanup.arn }
output "api_version" { value = aws_lambda_function.api.version }
output "cleanup_version" { value = aws_lambda_function.cleanup.version }
output "release_sha256_base64" { value = aws_lambda_function.api.code_sha256 }
output "scheduler_enabled" { value = var.scheduler_enabled }

output "runtime_data" {
  value = { reminders_table = var.reminders_table, owner_state_table = var.owner_state_table, image_jobs_table = var.image_jobs_table, images_bucket = var.images_bucket, restored_tables = var.restored_tables }
}
