# Agent Workflow Extension Findings

## Summary

Creating a Pi extension that drives a strict multi-stage agent workflow is plausible. Pi extensions can register commands, inject stage-specific instructions, send follow-up messages, display workflow status, persist state, and observe agent/tool lifecycle events.

A simple workflow could look like:

1. Initial stage: investigate, gather context, produce a handoff.
2. Middle stage: use the handoff to implement or transform work.
3. Final stage: review, validate, summarize, or request fixes.

The extension can make this feel like it takes over the session while still keeping normal Pi output visible to the user.

## Relevant Pi capabilities

Pi extensions support the pieces needed for this kind of orchestration:

- `pi.registerCommand()` for a command such as `/workflow`.
- `pi.sendUserMessage()` to queue the next stage automatically.
- `pi.sendMessage()` to show workflow progress or custom visible messages.
- `before_agent_start` to inject stage-specific system prompt additions.
- `agent_start`, `agent_end`, `turn_start`, and `turn_end` to track progress.
- `tool_call` to block, allow, or mutate tool calls based on the active stage.
- `ctx.ui.setStatus()` and `ctx.ui.setWidget()` to show current stage in the UI.
- `pi.appendEntry()` to persist workflow state in the session without adding it to model context.
- Command-context helpers like `ctx.waitForIdle()` to sequence stages from a command handler.

## Architecture option A: extension-driven single session

This is the most native-feeling approach.

```text
User runs /workflow <goal>
  -> extension sets current stage
  -> extension sends or transforms a prompt for stage 1
  -> agent runs normally and visibly
  -> extension waits for idle / observes completion
  -> extension validates the result
  -> extension sends stage 2 prompt
  -> repeat until final stage
```

Advantages:

- Simple to build compared with a custom SDK app.
- Keeps all output visible in the normal Pi session.
- Uses normal Pi tools, UI, and transcript behavior.
- Good fit for interactive workflows.

Tradeoffs:

- Stages are prompted roles in one shared session, not fully isolated agents.
- Strictness depends on prompt design, tool restrictions, and validation.
- Context can bleed between stages unless carefully managed.

## Architecture option B: extension orchestrates isolated subagents

For stricter workflows, the extension could run each stage as a separate agent-like unit and post results back into the main session.

```text
Main Pi session
  -> Stage 1 subagent produces handoff
  -> Stage 2 subagent consumes handoff and produces result
  -> Stage 3 subagent reviews result
  -> main session displays progress and final output
```

Advantages:

- Stronger isolation between stages.
- Easier to give each stage different prompts, models, or tool access.
- Cleaner handoff contracts.

Tradeoffs:

- More implementation complexity.
- Need to decide how much subagent output is shown in the main session.
- Requires careful state and transcript handling.

## Architecture option C: SDK workflow runner

If the goal is a fully automated pipeline rather than a Pi-native interactive flow, the Pi SDK may be cleaner than an extension.

A standalone runner could create sessions and execute stages programmatically:

```ts
await initialStage.prompt(goal);
await middleStage.prompt(initialHandoff);
await finalStage.prompt(middleResult);
```

Advantages:

- Maximum orchestration control.
- Easier to use in CI or headless automation.
- Cleaner validation and retry loops.

Tradeoffs:

- Less integrated with the normal Pi TUI unless a custom interface is built.
- More like a separate application than an extension.

## Recommended starting point

Start with an extension-driven single-session workflow.

A first version could expose:

```text
/workflow <goal>
```

and define stages like:

```ts
const stages = [
  {
    name: "Initial",
    instructions: "Investigate only. Do not edit files. Produce a structured handoff.",
    tools: ["read", "bash"],
  },
  {
    name: "Middle",
    instructions: "Use the handoff to perform the implementation.",
    tools: ["read", "edit", "write", "bash"],
  },
  {
    name: "Final",
    instructions: "Review the implementation, run checks, and summarize outcome.",
    tools: ["read", "bash"],
  },
];
```

Each stage should produce a structured result, for example:

```md
## Stage Result

Status: pass | fail | blocked

Summary:
...

Handoff:
...

Next-stage instructions:
...
```

The extension can then validate that output before advancing.

## Open design questions

Before implementing a complex workflow, decide:

1. Are stages merely prompted personas, or should they be truly isolated agents?
2. Should users be able to pause, approve, or edit handoffs between stages?
3. Should each stage have different tool permissions?
4. Should failures stop the workflow, retry the stage, or route to a repair stage?
5. Should the workflow state survive `/reload`, `/resume`, and session replacement?
6. How much intermediate output should be visible versus summarized?

## Bottom line

A strict staged workflow extension is feasible. The smallest useful implementation is a command-driven state machine that runs staged prompts in the current session and displays status. If the workflow needs stronger boundaries, isolated subagents or an SDK-based runner would be the next step.
