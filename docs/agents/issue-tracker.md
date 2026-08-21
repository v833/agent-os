# Local Markdown Issue Tracker

This project stores product specifications and implementation tickets as local
Markdown files.

- Feature directory: `.scratch/<feature-slug>/`
- Spec: `.scratch/<feature-slug>/spec.md`
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<ticket-slug>.md`
- Number tickets in dependency order, starting at `01`
- Each ticket must include `What to build`, `Blocked by`, `Status`, and acceptance criteria
- Use `ready-for-agent` as the status for work that can be picked up
- Do not implement code while producing the Spec or Tickets
