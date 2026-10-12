#!/bin/bash
cd "$HOME/lunifar-overtime-bot" || exit 1
source "$HOME/nodevenv/lunifar-overtime-bot/24/bin/activate"
exec node src/app.js
