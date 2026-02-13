#!/bin/bash
# Completion sound hook - plays when Claude finishes a task
ffplay /home/olet/mhaxbe/.claude/sounds/completion.mp3 -nodisp -autoexit -volume 50 >/dev/null 2>&1 &