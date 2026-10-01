#!/bin/bash
set -euo pipefail

[ -n "${GIT_USER_EMAIL:-}" ] && git config --global user.email "$GIT_USER_EMAIL"
[ -n "${GIT_USER_NAME:-}" ] && git config --global user.name "$GIT_USER_NAME"

gh auth setup-git
