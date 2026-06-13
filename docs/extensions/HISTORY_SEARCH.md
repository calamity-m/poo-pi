# History search

Press `F8` or run `/history [query]` to search prior user messages. The live picker shows the top 10 matches as you type, covering the current session plus saved Pi sessions across projects. Picking a result only populates the editor with that message text; it does not switch sessions, fork, or send anything.

To choose a different shortcut, set `{ "historySearch": { "shortcut": "ctrl+r" } }` in `~/.pi/agent/poo/core-settings.json`, then run `/reload`. For `Ctrl+R`, also rebind or disable Pi's built-in session rename shortcut in `~/.pi/agent/keybindings.json`, for example `{ "app.session.rename": ["f9"] }` or `{ "app.session.rename": [] }`.
