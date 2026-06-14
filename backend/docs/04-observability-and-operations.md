# Phase 4: Observability And Operations

## The Story

An auth service can be logically correct and still fail as a product because nobody can see what it is doing, explain why it failed, or operate it safely under pressure. This phase is where the backend grows up operationally.

The point is not to add dashboards for style points. The point is to make security-relevant behavior visible and the service survivable in real environments.

## Problems Encountered

- Logging is console-level rather than structured.
- There is no clear audit trail for security-sensitive events.
- Runtime health is not exposed in a way that helps operators.
- Graceful shutdown and deployment behavior are minimal.
- Environment configuration is still too development-friendly.
- Container setup is suitable for local work, not a hardened production shape.

## What The Correct Solution Looks Like

At the end of this phase, the backend should answer three operational questions quickly:

- What happened?
- Is it healthy?
- Can we safely change or restart it?

## Implementation Guidance

### 1. Separate Application Logs From Audit Events

These are not the same thing.

- Application logs explain program flow and failures.
- Audit events explain security-relevant actions and state transitions.

Examples of audit-worthy events:

- Registration created
- Login succeeded
- Login failed
- Session refreshed
- Refresh reuse detected
- Session revoked
- Password reset requested
- Password reset completed
- Admin-sensitive action executed

Audit events should be structured, consistent, and intentionally retained.

### 2. Add Request-Level Context Everywhere

Every meaningful log should carry enough context to correlate behavior.

Useful fields include:

- Request id
- User id when authenticated
- Session id when present
- Client type
- Source IP or proxy-aware source
- Route name
- Outcome code

Without correlation context, incident investigation becomes guesswork.

### 3. Define Health In Operational Terms

Do not stop at a generic ping endpoint.

Plan separate views of health:

- Liveness: the process is running
- Readiness: the service can currently serve traffic safely
- Dependency awareness: database connectivity and critical dependency state

Keep health endpoints cheap, predictable, and useful to deployment automation.

### 4. Harden Runtime Configuration

Configuration should fail fast when unsafe.

Correct production posture:

- Validate environment variables on startup
- Reject dangerous defaults in production
- Make secret requirements explicit
- Define proxy and TLS expectations clearly
- Distinguish local development configuration from deployed configuration

The main idea is simple: deployment errors should surface at startup, not during an incident.

### 5. Make Shutdown And Restart Behavior Boring

Production services need predictable lifecycle behavior.

Plan for:

- Graceful shutdown on termination signals
- Stopping new work before exit
- Closing database connections cleanly
- Avoiding partial writes during process termination
- Container health and restart behavior that matches real readiness

### 6. Harden The Container And Deployment Shape

A local Docker setup is not automatically a production image.

The deployment shape should eventually include:

- Non-root runtime
- Minimal production image
- No development bind mounts in production
- Health checks that align with readiness
- Resource expectations and environment isolation
- Clear secret injection model

### 7. Plan Metrics And Tracing Around Real Questions

Do not collect metrics just because it feels professional.

Collect what helps answer security and reliability questions:

- Login success and failure counts
- Refresh success and reuse detection counts
- Latency by endpoint
- Dependency error rates
- Rate-limit triggers
- Session revocation counts

Tracing becomes most useful when it ties HTTP requests to database work and failure points.

## Correctness Questions To Answer Before Coding

- Which events are application logs, which are audit events, and which are both?
- How long should audit data be retained?
- Which health checks are safe to expose publicly?
- What restart and deployment behavior is expected from the hosting platform?
- Which metrics are needed for security monitoring versus product monitoring?

## Anti-Patterns To Avoid

- Treating `console.log` as an observability strategy.
- Mixing audit meaning into free-form log text.
- Exposing a green health check that says nothing about readiness.
- Keeping dev-friendly secret defaults in production paths.
- Waiting until after launch to decide what should have been logged.

## Done Looks Like

- Structured logs exist with request and session context.
- Audit-worthy auth events are captured intentionally.
- Liveness and readiness are clearly defined.
- Startup fails fast on unsafe or incomplete config.
- Deployment and restart behavior are predictable and documented.
