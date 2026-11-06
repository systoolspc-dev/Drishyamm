#!/bin/sh
# Generate both WireGuard keypairs (using the gpu-bridge image, so no local
# wireguard-tools are needed) and write prod.env / office.env into OUT_DIR.
#
#   ./genkeys.sh OUT_DIR [PROD_ENDPOINT]
#
#   OUT_DIR        directory OUTSIDE this repo (keys must never be committed)
#   PROD_ENDPOINT  host:port the office dials (default 103.109.7.36:51820)
#
# Env: GPU_BRIDGE_IMAGE (default drishyam/gpu-bridge:latest)
set -eu

out=${1:?usage: genkeys.sh OUT_DIR [PROD_ENDPOINT]}
endpoint=${2:-103.109.7.36:51820}
image=${GPU_BRIDGE_IMAGE:-drishyam/gpu-bridge:latest}

mkdir -p "$out"
out_abs=$(cd "$out" && pwd -P)
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$repo" ]; then
  repo_abs=$(cd "$repo" && pwd -P)
  case "$out_abs/" in
    "$repo_abs"/*) echo "refusing: $out_abs is inside the git repo $repo_abs" >&2; exit 1 ;;
  esac
fi
for f in prod.env office.env; do
  [ -e "$out_abs/$f" ] && { echo "refusing: $out_abs/$f exists (delete it first to rotate keys)" >&2; exit 1; }
done

# One container run: two private keys and their public keys, one per line.
keys=$(docker run --rm --entrypoint sh "$image" -c '
  a=$(wg genkey); b=$(wg genkey)
  echo "$a"; echo "$a" | wg pubkey; echo "$b"; echo "$b" | wg pubkey' | tr -d '\r')
prod_priv=$(echo "$keys" | sed -n 1p)
prod_pub=$(echo "$keys" | sed -n 2p)
office_priv=$(echo "$keys" | sed -n 3p)
office_pub=$(echo "$keys" | sed -n 4p)
[ ${#prod_priv} -eq 44 ] && [ ${#office_pub} -eq 44 ] || { echo "key generation failed" >&2; exit 1; }

umask 077
cat > "$out_abs/prod.env" <<EOF
# gpu-bridge, PROD end (VMS server). Public key of this end: $prod_pub
WG_ADDRESS=10.8.0.1/24
WG_LISTEN_PORT=51820
WG_PRIVATE_KEY=$prod_priv
WG_PEER_PUBLIC_KEY=$office_pub
WG_PEER_ALLOWED_IPS=10.8.0.2/32
EOF
cat > "$out_abs/office.env" <<EOF
# gpu-bridge, OFFICE end (GPU box). Public key of this end: $office_pub
WG_ADDRESS=10.8.0.2/24
WG_PRIVATE_KEY=$office_priv
WG_PEER_PUBLIC_KEY=$prod_pub
WG_PEER_ALLOWED_IPS=10.8.0.1/32
WG_PEER_ENDPOINT=$endpoint
WG_KEEPALIVE=25
EOF
chmod 600 "$out_abs/prod.env" "$out_abs/office.env" 2>/dev/null || true

echo "wrote $out_abs/prod.env   (prod public key   $prod_pub)"
echo "wrote $out_abs/office.env (office public key $office_pub)"
echo "copy each file to its host only; do not commit or paste them anywhere."
