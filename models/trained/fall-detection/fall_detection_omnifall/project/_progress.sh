#!/usr/bin/env bash
F="/mnt/c/Users/systo/AppData/Local/Temp/claude/c--projects-fall-detection-omnifall/3930f6f0-17fa-4dcb-82f6-5dad7265920e/tasks/b0ho5qsnf.output"
# last progress token for fall and adl bars
tr '\r' '\n' < "$F" | grep -aE '^(fall|adl):' | tail -1
echo "--- stage markers seen ---"
grep -aE '\[1/3\]|\[2/3\]|\[3/3\]|MERGED|s2 present|epoch|Best val|DONE|Aborted|Segmentation|double free|Traceback' "$F" | tr '\r' '\n' | grep -aE '\[1/3\]|\[2/3\]|\[3/3\]|MERGED|s2 present|epoch|Best val|DONE|Aborted|Segmentation|double free|Traceback' | tail -8
