# Shared helpers. Source this, don't run it.
#
# The ElevenLabs API key is read from the environment ($ELEVENLABS_API_KEY).
# For local use you can instead point ELEVENLABS_ENV_FILE at a .env file that
# defines it.
ENV_FILE="${ELEVENLABS_ENV_FILE:-}"

load_key() {
  [ -n "${ELEVENLABS_API_KEY:-}" ] && return 0

  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    export ELEVENLABS_API_KEY="$(grep -m1 '^ELEVENLABS_API_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  fi

  if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
    echo "ERROR: no ELEVENLABS_API_KEY (export it, or point ELEVENLABS_ENV_FILE at a .env that defines it)" >&2; exit 1
  fi
}

# Never echo the key. Callers must not set -x.
