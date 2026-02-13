#!/bin/bash
# Notification sound hook - plays when Claude is prompting/waiting
ffplay /home/olet/mhaxbe/.claude/sounds/notification.mp3 -nodisp -autoexit -volume 50 >/dev/null 2>&1 &