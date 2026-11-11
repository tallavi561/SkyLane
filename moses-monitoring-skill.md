---
name: moses-monitoring-integration
description: Wire this codebase's services into MoSes Monitor - send real logs and live process status so they show up in the Architecture page and are searchable, instead of being registered manually through the UI.
---

# MoSes Monitor integration

You are setting up a codebase to report into a MoSes Monitor instance: a log/process
monitoring system with a custom search index, a live architecture graph (nodes +
connections), and automatic health checks. Follow this document to wire the codebase's
services in. Everything here is plain HTTP - no SDK or client library to install, in any
language.

**Base URL** (the MoSes API gateway for this instance):

```
https://api-gateway-x17f.onrender.com
```

If the person running this told you a different URL, use that instead - this is just the
default for the instance this skill was downloaded from. All paths below are relative to
this base URL.

## What to do

1. **Find the services/processes in this repo.** Each independently-run process (a web
   server, a worker, a cron job, a CLI daemon that stays up) is one "node" in MoSes.
   Pick a short, stable `serviceName` for each (e.g. `payments-api`, `email-worker`) -
   this name is the node's identity, so keep it consistent across restarts.

2. **For each service, send a heartbeat on startup and then periodically** (every
   15-60 seconds is reasonable - pick an interval and set up a timer/scheduled task,
   whatever is idiomatic for this language/framework):

   ```
   POST /api/process/heartbeat
   Content-Type: application/json

   {
     "serviceName": "payments-api",
     "status": "UP",
     "description": "Handles checkout and refunds",
     "connections": ["user-db", "email-worker"]
   }
   ```

   - `status` is one of `UP`, `DEGRADED`, `DOWN`, `UNKNOWN`. Send `UP` as long as the
     process is healthy; if you can cheaply detect a degraded state (e.g. a dependency
     is failing but the service still partially works), send `DEGRADED`.
   - `description` is optional free text - one sentence on what the service does.
   - `connections` is optional: the `serviceName`s of other services *this one calls*.
     List every service it makes outbound calls to, using the same names you picked for
     them. MoSes draws an edge for each and creates a default connection object you (or
     the person using MoSes) can later annotate with protocol/description in the UI -
     you don't need to describe the connection further here.
   - `cpuPercent` and `memoryMb` are optional resource metrics - **include them in every
     heartbeat** so MoSes can show each service's load on the Architecture page. Sample
     them cheaply at heartbeat time, using whatever is idiomatic for the runtime:
     - `cpuPercent`: the process's CPU use over the last interval, as a percent of one
       core (0-100 for a single core; it may exceed 100 on multi-core). Compute it from
       the delta of the process's CPU time divided by the elapsed wall time (e.g.
       `process.cpuUsage()` in Node, `psutil.Process().cpu_percent()` in Python,
       `OperatingSystemMXBean.getProcessCpuLoad()` in Java, `runtime`/cgroup stats in Go).
     - `memoryMb`: the process's resident memory in megabytes (e.g.
       `process.memoryUsage().rss`, `psutil.Process().memory_info().rss`, JVM
       `Runtime.totalMemory() - freeMemory()`). Values must be numbers >= 0.
     If a number can't be read on some platform, omit that field rather than sending 0.
     Example: `{"serviceName":"payments-api","status":"UP","cpuPercent":12.5,"memoryMb":184}`.
     Services that only use a `probeUrl` (no periodic heartbeat) have no metrics - if you
     want metrics for one, send heartbeats too.
   - Any log received for a `serviceName` also counts as proof of life. If neither a
     heartbeat nor a log arrives for a few minutes (3 by default), MoSes marks the node
     DOWN automatically - so a heartbeat every 15-60 seconds keeps a quiet service UP.

   Alternative to heartbeats: if the service already exposes a health-check endpoint
   (e.g. `GET /health`), you can instead register it once with a `probeUrl` and skip the
   periodic POSTs entirely - MoSes will poll that URL itself:

   ```
   POST /api/process/heartbeat
   Content-Type: application/json

   {
     "serviceName": "payments-api",
     "status": "UP",
     "probeUrl": "https://payments-api.internal.example.com/health",
     "connections": ["user-db", "email-worker"]
   }
   ```

   Only one heartbeat with `probeUrl` set is needed (not periodic) - MoSes takes over
   polling that URL on its own schedule from then on and updates `status` itself. Use
   this when the health endpoint is reachable from the MoSes instance (same network/
   public internet); use periodic heartbeats instead if it's only reachable from inside
   the service's own process (e.g. no public health endpoint at all).

3. **Send logs** for anything you'd currently print/log to stdout or a log file -
   requests, errors, significant state changes:

   ```
   POST /api/logs
   Content-Type: application/json

   {
     "serviceName": "payments-api",
     "logLevel": 2,
     "ip": "10.0.4.12",
     "rawMessage": "POST /checkout 200 142ms",
     "timestamp": "2026-01-15T10:30:00Z"
   }
   ```

   - `logLevel` is a number: `0` TRACE, `1` DEBUG, `2` INFO, `3` WARN, `4` ERROR,
     `5` FATAL.
   - `ip` is optional (the client/request IP, when there is one).
   - `timestamp` is optional (ISO-8601 UTC); omit it and the server stamps receipt time.
   - **All logging must go through one dedicated `Logger` class** (or the language's
     equivalent: a module, a wrapper around the existing logging library) that this
     codebase uses everywhere instead of `print`/`console.log`/`System.out`. That single
     class is the only place that talks to MoSes: it exposes `trace/debug/info/warn/error/
     fatal` methods, stamps `serviceName`, level and timestamp, and POSTs to `/api/logs`.
     If the codebase already has a logging library, build the `Logger` as a thin wrapper/
     transport on top of it and replace direct `print`/`console` calls with it. Do not
     scatter raw `fetch`/`POST` calls through the business logic.
   - The `Logger` must send asynchronously (queue + batch/flush in the background) and
     never block or throw into request handling. If MoSes is unreachable, fall back to
     local stdout and drop or retry quietly.
   - **Every incoming request must be logged through that `Logger`** (and therefore sent
     to MoSes): add one HTTP middleware/filter/interceptor per service that logs method,
     path, status code and duration (e.g. `POST /checkout 200 142ms`) at INFO, and 4xx/5xx
     at WARN/ERROR, including the client `ip`. Also log every outbound call this service
     makes to another service in `connections` (same format), so traffic between services
     shows up on both sides.
   - **Correlate every request with a `traceId`** so MoSes can show "everything that
     happened for this one request" across services. In the request-logging middleware:
     1. Read the incoming `X-Trace-Id` header; if it is missing, generate a new random
        id (a UUID, or 16+ hex chars) - this is the request's `traceId`.
     2. Generate a fresh short `spanId` (8+ hex chars) for this service's handling of the
        request, and read the caller's span from the incoming `X-Parent-Span-Id` header
        if present.
     3. Keep both in request-scoped context (async-local storage, `contextvars`,
        `ThreadLocal`/MDC, Go `context.Context`...) so the `Logger` can attach `traceId`
        and `spanId` automatically to every log written during that request - business
        code should not pass them around by hand.
     4. On every outbound call to another service, send `X-Trace-Id: <traceId>` and
        `X-Parent-Span-Id: <spanId>` headers. The downstream service's middleware
        (step 1) then continues the same trace.
     5. Put them in the log payload as optional `traceId` / `spanId` fields:
        `{"serviceName":"payments-api","logLevel":2,"rawMessage":"POST /checkout 200 142ms","traceId":"3f2a...","spanId":"9c1d..."}`.
     Logs outside any request (startup, background jobs) simply omit both fields. Don't
     put the traceId inside `rawMessage` - use the dedicated fields.
   - Don't log secrets, full request/response bodies, or personal data in `rawMessage`.

4. **Double-check the `connections` lists are consistent.** If service A lists B as a
   connection, that's enough - B doesn't also need to list A back (MoSes dedupes either
   direction into one edge). Prefer listing a connection from the caller's side.

5. **Report back to the person running this** what you set up: which services got
   heartbeats (and whether they report `cpuPercent`/`memoryMb`), which got probe URLs
   instead, where the `Logger` class lives, where the request-logging middleware was
   added, and how the `traceId` is propagated between services - so
   they can verify it in the MoSes Architecture and Search pages.

## What NOT to do

- Don't add a dependency/SDK for this - it's a few HTTP calls.
- Don't send heartbeats or logs from code that isn't actually part of a long-running
  service (e.g. one-off scripts, build tooling, tests).
- Don't invent a `serviceName` that doesn't match what you listed in another service's
  `connections` array - names must match exactly (case-sensitive) for edges to connect.
- Don't block application startup or request handling waiting on these HTTP calls - fire
  heartbeats/logs asynchronously and swallow (log locally, don't crash) failures, since
  MoSes being unreachable should never take the monitored service down with it.
