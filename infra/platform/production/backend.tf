terraform {
  backend "s3" {
    key          = "production/platform/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
