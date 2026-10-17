output "reminders_table" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["reminders"].name : data.aws_dynamodb_table.restored["reminders"].name) }
output "reminders_table_arn" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["reminders"].arn : data.aws_dynamodb_table.restored["reminders"].arn) }
output "owner_state_table" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["owner_state"].name : data.aws_dynamodb_table.restored["owner_state"].name) }
output "owner_state_table_arn" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["owner_state"].arn : data.aws_dynamodb_table.restored["owner_state"].arn) }
output "image_jobs_table" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["image_jobs"].name : data.aws_dynamodb_table.restored["image_jobs"].name) }
output "image_jobs_table_arn" { value = (length(var.restored_tables) == 0 ? aws_dynamodb_table.runtime["image_jobs"].arn : data.aws_dynamodb_table.restored["image_jobs"].arn) }
output "images_bucket" { value = aws_s3_bucket.images.bucket }
output "images_bucket_arn" { value = aws_s3_bucket.images.arn }
output "api_role_arn" { value = var.api_role_arn }
output "cleanup_role_arn" { value = var.cleanup_role_arn }
output "api_log_group" { value = aws_cloudwatch_log_group.runtime["api"].name }
output "cleanup_log_group" { value = aws_cloudwatch_log_group.runtime["cleanup"].name }
output "gateway_log_group" { value = aws_cloudwatch_log_group.gateway.name }
output "cognito_issuer" { value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.production.id}" }
output "cognito_client_id" { value = aws_cognito_user_pool_client.chrome.id }
output "cognito_auth_base_url" { value = "https://${aws_cognito_user_pool_domain.production.domain}.auth.${var.region}.amazoncognito.com" }
output "restored_tables" { value = var.restored_tables }
