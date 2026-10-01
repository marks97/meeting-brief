# Resolve AWS creds for the CURRENT project, not a global profile.
# A project can keep its own .env with its own AWS account. Source this.
#
# Variable names are not always standardised. This tries the canonical
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY first, then a short-form
# AWS_ACCESS_KEY / AWS_ACCESS_SECRET fallback, in that order of specificity.
load_aws_from_env_file() {
  local envf="$1"
  [ -f "$envf" ] || return 1
  local id secret region
  id=$(grep -m1 -E '^AWS_ACCESS_KEY_ID=' "$envf" | cut -d= -f2-)
  [ -z "$id" ] && id=$(grep -m1 -E '^AWS_ACCESS_KEY=' "$envf" | cut -d= -f2-)
  secret=$(grep -m1 -E '^AWS_SECRET_ACCESS_KEY=' "$envf" | cut -d= -f2-)
  [ -z "$secret" ] && secret=$(grep -m1 -E '^AWS_ACCESS_SECRET=' "$envf" | cut -d= -f2-)
  region=$(grep -m1 -E '^AWS_(DEFAULT_)?REGION=' "$envf" | cut -d= -f2-)
  [ -n "$id" ] && [ -n "$secret" ] || return 1
  export AWS_ACCESS_KEY_ID="$id" AWS_SECRET_ACCESS_KEY="$secret"
  export AWS_DEFAULT_REGION="${region:-us-east-1}"
  return 0
}

# Walk up from $1 (default cwd) to the first .env that yields usable creds.
resolve_aws() {
  local d="${1:-$PWD}"
  while [ "$d" != "/" ]; do
    if load_aws_from_env_file "$d/.env"; then echo "aws creds <- $d/.env" >&2; return 0; fi
    d=$(dirname "$d")
  done
  echo "ERROR: no .env with AWS creds found walking up from ${1:-$PWD}" >&2
  return 1
}
