#!/usr/bin/env bash
set -euo pipefail

# The native image (ubi9-micro) has neither python3 nor getent, so parse /etc/hosts in Bash.
# Docker's own hostname resolves via /etc/hosts; never select a peer or loopback.
refuse() {
  echo "Floci local JWT startup refused: $1" >&2
  exit 1
}

declare -A addresses=()
while read -r address names; do
  [[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  for name in $names; do
    [[ $name == \#* ]] && break
    if [[ $name == "$HOSTNAME" ]]; then
      addresses[$address]=1
    fi
  done
done < /etc/hosts

(( ${#addresses[@]} == 1 )) || refuse "expected exactly one own IPv4 address"
floci_ip=${!addresses[*]}

octet='(0|[1-9][0-9]{0,2})'
[[ $floci_ip =~ ^$octet\.$octet\.$octet\.$octet$ ]] || refuse "invalid own IPv4 address"
a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
(( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || refuse "invalid own IPv4 address"
if ! (( a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) )); then
  refuse "own IPv4 address must be RFC1918 private"
fi

export FLOCI_HOSTNAME="$floci_ip"
export FLOCI_BASE_URL="http://$floci_ip:4566"
exec /app/application \
  -Dquarkus.http.host=0.0.0.0 \
  -Dfloci.security.allow-unsafe-network-exposure=true
