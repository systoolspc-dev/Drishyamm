#!/bin/bash
# Keeps new RTSP sessions to a lab NVR under what it tolerates. Over its limit
# the NVR answers 401 and then locks this server out for 30 minutes.
# Only NEW connections to NVR:554 are affected; running streams never are.
# Remove: /data/build/nvr-guard.sh off
set -e
NVR=${NVR_IP:?usage: NVR_IP=<nvr address> nvr-guard.sh [off]}
MEDIA_MAX=10   # sessions opened by the media server (AI, recording)
TOTAL_MAX=18   # sessions from this server in total
C=NVRGUARD
SS=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" drisyam-original-stream-service)
iptables -D DOCKER-USER -d $NVR -p tcp --dport 554 --syn -j $C 2>/dev/null || true
iptables -F $C 2>/dev/null || true
iptables -X $C 2>/dev/null || true
[ "$1" = off ] && exit 0
iptables -N $C
[ -n "$SS" ] && iptables -A $C -s "$SS" -p tcp -m connlimit --connlimit-above $MEDIA_MAX --connlimit-mask 32 --connlimit-daddr -j REJECT --reject-with tcp-reset
iptables -A $C -p tcp -m connlimit --connlimit-above $TOTAL_MAX --connlimit-mask 32 --connlimit-daddr -j REJECT --reject-with tcp-reset
iptables -A $C -m hashlimit --hashlimit-upto 30/min --hashlimit-burst 2 --hashlimit-mode dstip --hashlimit-name nvrguard -j RETURN
iptables -A $C -j DROP
iptables -I DOCKER-USER -d $NVR -p tcp --dport 554 --syn -j $C
