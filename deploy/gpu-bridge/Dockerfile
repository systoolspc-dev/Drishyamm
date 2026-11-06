# Drishyam gpu-bridge: one WireGuard peer + plain TCP port forwards.
# The same image runs on both ends (prod VMS server and office GPU box).
FROM alpine:3.20

RUN apk add --no-cache wireguard-tools-wg iproute2 iptables socat

COPY entrypoint.sh /usr/local/bin/gpu-bridge
COPY healthcheck.sh /usr/local/bin/gpu-bridge-health
# Strip CR defensively in case the files were checked out with CRLF on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/gpu-bridge /usr/local/bin/gpu-bridge-health \
 && chmod 0755 /usr/local/bin/gpu-bridge /usr/local/bin/gpu-bridge-health

# Healthy only while the peer has completed a handshake in the last 180 s.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/usr/local/bin/gpu-bridge-health"]

ENTRYPOINT ["/usr/local/bin/gpu-bridge"]
