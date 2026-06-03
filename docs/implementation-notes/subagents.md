# Subagents implementation notes

Manual verification checklist for the core subagents extension:

1. Run `/core-settings` and configure `Subagent fast model` / `Subagent high model`, or use `/core-settings edit` with:
   ```json
   {
     "version": 1,
     "subagents": {
       "fast": { "model": "provider/model-id", "thinkingLevel": "off" },
       "high": { "model": "provider/model-id", "thinkingLevel": "high" }
     }
   }
   ```
2. Ask the parent agent to call `spawn_subagent` with no tier and confirm it uses the current `/model` selection.
3. Ask for `tier: "fast"` and `tier: "high"` and confirm the configured models are selected.
4. Run `/subagents` while and after a subagent runs to inspect the bounded in-memory run list.
5. With the core proxy active, clear `.pi/proxy-audit`, run a no-tier subagent, and confirm a new audit request record is written.
6. Cancel a running subagent with Esc/Ctrl+C and confirm the run is marked aborted and no status/widget remains stuck.
