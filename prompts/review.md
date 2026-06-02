---
description: Review current repository changes for correctness and risk
argument-hint: "[focus]"
---
Review the current repository changes. If arguments are provided, focus on: $ARGUMENTS

Default focus: correctness, security, maintainability, and test coverage.

Please:
- inspect the diff and relevant surrounding code
- identify concrete issues only
- include file paths and line references where possible
- distinguish must-fix problems from suggestions
- recommend the smallest safe fix for each issue
