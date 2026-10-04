output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "artifact_bucket" { value = aws_s3_bucket.artifacts.bucket }
output "artifact_role_arn" { value = aws_iam_role.github["artifact"].arn }
output "plan_role_arn" { value = aws_iam_role.github["plan"].arn }
output "apply_role_arn" { value = aws_iam_role.github["apply"].arn }
