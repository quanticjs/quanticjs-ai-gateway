---
globs: "client/src/**/*.{ts,tsx}"
---

# Workflow UI — Use `@quanticjs/workflow-ui`, Don't Rebuild It

`@quanticjs/workflow-ui` provides the **complete workflow UI layer** for task management. Every component and hook below is already implemented. Import and use it — never write your own version.

## Connection to QuanticFlow

The frontend does **not** talk to QuanticFlow directly. All workflow API calls go through the NestJS backend (BFF), which forwards to QuanticFlow via `WorkflowClientService`. The frontend uses `@quanticjs/workflow-ui` hooks that call the backend's `/api/workflows` and `/api/tasks` endpoints.

```
Browser → httpOnly cookie → NestJS BFF → WorkflowClientService → QuanticFlow
                                              (circuit breaker)
```

## Provider

| Export | Purpose |
|---|---|
| `WorkflowProvider` | Context provider for workflow hooks — wraps pages that use workflow features |

## Hooks

| Hook | Purpose |
|---|---|
| `useTaskList(filters?)` | Fetches task inbox — filterable by status, role, assignee |
| `useTask(taskId)` | Fetches single task with full context (process variables, form schema) |
| `useTaskClaim(taskId)` | Claim/unclaim a task for the current user |
| `useTaskAction(taskId)` | Complete, delegate, or skip a task with payload |
| `useProcessTimeline(processInstanceId)` | Fetches workflow state history — completed/pending/active nodes |

## Components

| Component | Purpose |
|---|---|
| `TaskInbox` | Full task list with filtering, sorting, pagination — renders role-based task assignments |
| `WorkflowForm` | Dynamic form rendered from task form schema — integrates with `useTaskAction` |
| `TaskDetail` | Task context view — process variables, form, history, actions |
| `TaskActions` | Approve/reject/claim/delegate action buttons — wired to `useTaskAction` |
| `ProcessTimeline` | Visual workflow state diagram — completed (green), active (yellow), blocked (red) |

## When to Use

| Feature need | Use |
|---|---|
| Dashboard task list | `TaskInbox` |
| Approval interfaces | `TaskDetail` + `TaskActions` |

## What Goes in Application Code vs. workflow-ui

| Belongs in **application code** | Belongs in **workflow-ui** (already built) |
|---|---|
| Domain-specific approval pages | Task inbox with filtering/sorting/pagination (`TaskInbox`) |
| Custom approval form layouts composing `TaskDetail` | Task context view + form rendering (`TaskDetail`, `WorkflowForm`) |
| Page routing to task views | Approve/reject/claim/delegate buttons (`TaskActions`) |
| Workflow page wrappers with `WorkflowProvider` | Process state visualization (`ProcessTimeline`) |
| Domain-specific task filters | Task fetching, claiming, action hooks |

## Backend Endpoints the Hooks Expect

The backend must proxy these to QuanticFlow:

| Frontend hook | Backend endpoint | QuanticFlow endpoint |
|---|---|---|
| `useTaskList` | `GET /api/tasks` | `GET /api/tasks` |
| `useTask` | `GET /api/tasks/:id` | `GET /api/tasks/:id` |
| `useTaskClaim` | `POST /api/tasks/:id/claim` | `POST /api/tasks/:id/claim` |
| `useTaskAction` | `POST /api/tasks/:id/complete` | `POST /api/tasks/:id/complete` |
| `useProcessTimeline` | `GET /api/workflows/instances/:id/timeline` | `GET /api/workflows/instances/:id/timeline` |

## NEVER

- **NEVER** write your own task inbox component — use `TaskInbox` from `@quanticjs/workflow-ui`
- **NEVER** write your own task detail/actions UI — use `TaskDetail` + `TaskActions` from `@quanticjs/workflow-ui`
- **NEVER** write your own workflow visualization — use `ProcessTimeline` from `@quanticjs/workflow-ui`
- **NEVER** write your own dynamic form renderer for workflow tasks — use `WorkflowForm` from `@quanticjs/workflow-ui`
- **NEVER** write your own task list/claim/complete hooks — use `useTaskList` / `useTaskClaim` / `useTaskAction` from `@quanticjs/workflow-ui`
- **NEVER** write your own process timeline hook — use `useProcessTimeline` from `@quanticjs/workflow-ui`
- **NEVER** use workflow hooks outside a `WorkflowProvider` — wrap workflow pages with it
- **NEVER** call QuanticFlow directly from the frontend — all calls go through the NestJS backend (BFF)
