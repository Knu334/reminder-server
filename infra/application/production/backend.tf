terraform {
  backend "s3" {
    key          = "production/application/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
