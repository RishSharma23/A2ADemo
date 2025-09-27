# A2A Demo — Multi-Agent Streaming UI with Citations & HITL

A production-style proof-of-concept that demonstrates how a browser UI can talk **directly** to an A2A **Assistant** over **SSE** (no extra API layer), while the Assistant routes to specialized **tool agents** (GraphQL/Data, Weather, Calculator), streams **artifacts** (Chart.js specs, CSV), and surfaces **citations** and the **intent route**. The project also showcases **Human-in-the-Loop (HITL)** using the A2A `input-required` state.

> **Tech:** AngularJS 1.x UI · A2A JS SDK (server/client) · Node/Express agents · Chart.js · Azure OpenAI (intent/analysis) · OpenWeather API (demo data)

---

## Table of Contents

* [Why this POC](#why-this-poc)
* [What’s included](#whats-included)
* [Architecture](#architecture)
* [Repository layout](#repository-layout)
* [Getting started](#getting-started)
* [How it works](#how-it-works)
* [Try these in the UI](#try-these-in-the-ui)
* [HITL (Human-in-the-Loop)](#hitl-human-in-the-loop)
* [Citations & Intent Path](#citations--intent-path)
* [SSE: streaming model & notes](#sse-streaming-model--notes)
* [Production guidance (BFF, persistence, observability)](#production-guidance-bff-persistence-observability)
* [Runbook: common issues & fixes](#runbook-common-issues--fixes)
* [FAQ](#faq)
* [License](#license)

---

## Why this POC

* **Aim:** Validate that **A2A can front the UI** as the microservice boundary (single SSE stream, structured events) **without** introducing a separate API layer.
* **Scope:** Demonstrate **citations** and **intent paths** in agent outputs; showcase **HITL** using A2A’s native `input-required`; stream **artifacts** (chart spec, CSV); and document **production patterns** (BFF, persistence, auth, observability).

---

## What’s included

* **Assistant Agent** — Orchestrates routing, merges outputs, adds citations/intent path, manages HITL bridge.
* **Tool Agents**

  * **GraphQL/Data** — Mock dataset, GraphQL queries, **chart** generation (Chart.js spec), **CSV** export (HITL confirmation), LLM analysis.
  * **Weather** — Simple OpenWeather integration.
  * **Calculator** — Arithmetic with precedence.
* **AngularJS UI** — Single **SSE** stream to the Assistant using the A2A client; renders chat, **artifacts**, **citations**, **intent** chip, and **HITL** prompts.

---

## Architecture



1. **Overall architecture**
   <img width="3840" height="1063" alt="Untitled diagram _ Mermaid Chart-2025-08-15-232040" src="https://github.com/user-attachments/assets/7a4afbdf-b49c-41d8-9a0e-cd4c4da1923a" />

2. **Overall architecture (detailed, CORS + HITL highlighted)**
   <img width="3840" height="2143" alt="Untitled diagram _ Mermaid Chart-2025-08-18-230610" src="https://github.com/user-attachments/assets/152b0bed-c3e8-43b4-b346-c26333f6845c" />


3. **Frontend ↔ A2A backend flow (detailed event flow)**
   <img width="3840" height="3749" alt="Untitled diagram _ Mermaid Chart-2025-08-18-230629" src="https://github.com/user-attachments/assets/58a463d4-006f-4aad-94a5-9b5818ca06a4" />

4. **HITL flow (detailed)**
   <img width="2939" height="3840" alt="Untitled diagram _ Mermaid Chart-2025-08-18-230646" src="https://github.com/user-attachments/assets/5aec599d-a508-44fd-a782-e4bb96cbdd45" />





---

## Repository layout

```
A2A-demo/
├── .env                         # Azure/OpenAI keys, OpenWeather key, AGENT_URLS (dev)
├── package.json
├── package-lock.json
├── README.md
│
├── agents/
│   ├── assistant-agent.js       # orchestrator (SSE server, routing, HITL bridge, citations/intent)
│   ├── calculator-agent.js      # arithmetic tool (SSE server)
│   ├── weather-agent.js         # weather tool (SSE server)
│   └── graphql-agent.js         # data tool (GraphQL, charts, CSV, HITL; SSE server)
│
└── frontend/
    ├── index.html               # AngularJS UI (loads A2AClient, UUID inline)
    ├── app.js                   # ChatController; sendMessageStream; render artifacts/citations
    └── a2a-client.js            # A2A JS client wrapper (module)
```

---

## Getting started

### 1) Clone & install

```bash
git clone https://github.com/RishSharma23/A2ADemo.git
cd A2ADemo
npm install
```

> **Node version:** v18+ recommended.

### 2) Configure environment

Create a `.env` at repo root (or set env vars):

```ini
# Azure OpenAI (used by Assistant + GraphQL analysis)
OPENAI_AZURE_ENDPOINT=
OPENAI_AZURE_KEY=
OPENAI_AZURE_DEPLOYMENT_NAME=        # e.g., gpt-4-1 or your deployment name
OPENAI_AZURE_API_VERSION=

# Weather agent
OPENWEATHER_KEY=

# Assistant discovery (dev convenience)
# Comma-separated list of tool base URLs
AGENT_URLS=http://localhost:41234,http://localhost:41232,http://localhost:41233
```

### 3) Start agents (separate terminals; start Assistant last)

```bash
# Terminal A (GraphQL Tool)
node agents/graphql-agent.js        # http://localhost:41234

# Terminal B (Weather Tool)
node agents/weather-agent.js        # http://localhost:41232

# Terminal C (Calculator Tool)
node agents/calculator-agent.js     # http://localhost:41233

# Terminal D (Assistant - start last)
node agents/assistant-agent.js      # http://localhost:41231
```

You should see logs confirming each agent is listening and serving `/.well-known/agent.json`.

### 4) Serve frontend

Open `frontend/index.html` directly in a browser **or** serve via a local web server (recommended):

```bash
npx http-server frontend -p 8000
# then open http://localhost:8000
```

> In dev we enable **CORS** on each agent so the browser can call `http://localhost:41231`.

---

## How it works

* **UI → Assistant (SSE)**
  The AngularJS UI creates an `A2AClient("http://localhost:41231")` and calls `sendMessageStream(params)`, consuming events with `for await (const event of stream)`. The stream delivers:

  * `task` (submitted)
  * `status-update` (working / input-required / completed / cancelled)
  * `artifact-update` (e.g., `chart.json`, `data.csv`)

* **Assistant → Tools (A2A)**
  The Assistant discovers tools from `AGENT_URLS` by fetching `/.well-known/agent.json`, then routes to a tool by **name/skill**. It **proxies** tool events back to the UI and:

  * merges **citations**
  * adds **intentPath** (assistant skill → tool.skill)
  * manages **HITL** bridging (assistant task ↔ tool task)

* **Artifacts**

  * **Chart**: tool sends `chart.json` → `{ type: "chartjs", chart: <Chart.js config> }`; the UI renders via Chart.js.
  * **CSV**: tool sends base64 CSV as an artifact; the UI offers a download link.

* **HITL**
  Tool emits `status.state = "input-required"` with a user prompt (e.g., “Export 3 rows? yes/no”). The UI shows a normal assistant bubble. The next user message continues **the same assistant task**, which the Assistant forwards to the correct tool task via its HITL bridge.

---

## Try these in the UI

* **Math:**
  `What is 25 * 4 + 16?`
* **Weather:**
  `What is the weather in Laguna Beach?`
* **Data (GraphQL):**

  ```
  query { allSites { name location production } }
  ```
* **Data (analysis):**
  `What is the site with the highest production?`
* **Chart + CSV flow (shows citations + intent chip + HITL):**

  * `Give me a chart for this` *(after the GraphQL query)*
  * `make this into a csv` → **HITL prompt** → reply `yes`

---

## HITL (Human-in-the-Loop)

* **State:** tool sends `status.state = "input-required"`.
* **Assistant bridge:** records `{ assistantTaskId → tool task/context }`.
* **UI:** renders prompt as a normal assistant bubble (with “Input required” chip).
* **Continuation:** user replies keep the **assistant taskId**; Assistant resumes the tool task through the bridge (supports multiple clarification rounds).

---

## Citations & Intent Path

Each assistant final message and any artifact can include:

```json
{
  "citations": [
    { "id": "gql-dataset", "label": "Compressor dataset", "kind": "internal", "tool": "GraphQL Tool Agent" },
    { "id": "chart-skill", "label": "Chart Generation skill", "kind": "doc", "tool": "GraphQL Tool Agent" }
  ],
  "intentPath": ["assistant.general_assistant", "GraphQL Tool Agent.chart_output"]
}
```

The UI shows a **“View Sources”** section (collapsible) and an **Intent** chip under the bubble/artifact.

---

## SSE: streaming model & notes

* **One stream per task** from the browser to the **Assistant** (public port).
* Tools run on internal ports; the browser never connects to tools directly.
* **Keep-alives**: the Assistant sends periodic comments to avoid idle timeouts; configure your proxy/LB to disable buffering and extend read timeouts.
* **Payloads**: prefer small JSON events; stream **chart specs** (tiny) instead of images; for large files, switch to **signed URLs** in production.

---

## Production guidance (BFF, persistence, observability)

While the UI can talk directly to the Assistant in this POC, production deployments should place a thin **BFF (Backend-for-Frontend)** in front of the Assistant:

* **Same UI contract**: the BFF simply proxies `/message/stream` (SSE) and `/message` to the Assistant; the event schema does not change.
* **Adds governance**:

  * **Auth/SSO** (JWT/cookies), **rate limits**, request **budgets**, **redaction**
  * **Persistence** for tasks/HITL (Redis/DB) instead of in-memory stores
  * **Observability**: tracing/log correlation by `taskId/contextId`, structured logs/metrics
  * **Artifacts**: serve **signed URLs** for large binaries
* **Network**: keep **Assistant** private; tools remain internal. The BFF is the only public surface.

---

## Runbook: common issues & fixes

**“Task not found …” after HITL reply**

* Cause: continuing with a **tool taskId** instead of the **assistant taskId**.
* Fix: the UI must always continue with **assistant taskId/contextId**. The Assistant forwards to the tool via its HITL bridge.

**Duplicate bubbles / repeated “working” text**

* Cause: forwarding tool final `completed` text and also sending a composed assistant final.
* Fix: buffer the tool’s final text and **do not** forward the tool’s `completed` message as a separate bubble; only publish one assistant final.

**HITL prompt appears in the wrong place**

* Cause: misplaced container divs or rendering HITL outside the chat repeat.
* Fix: emit the HITL prompt as a **normal assistant message** at the bottom; ensure it’s part of the message list (`ng-repeat`) and not a separate toolbar-only notice.

**CORS errors in dev**

* Cause: serving UI on a different origin than the agents.
* Fix: `app.use(cors())` on all agents or serve UI via same origin / BFF. (In prod, prefer same origin through BFF and disable public CORS.)

**Charts not rendering**

* Cause: artifact not flagged as `{ type: "chartjs", chart: { ... } }` or Chart.js not initialized after DOM paint.
* Fix: ensure artifact shape; call `new Chart(canvas.getContext('2d'), config)` in a timeout/next tick after the bubble renders.

**Weather failures**

* Cause: missing/invalid `OPENWEATHER_KEY`.
* Fix: supply a valid key; check agent logs.

**Azure OpenAI errors**

* Cause: deployment name/version mismatch or missing env vars.
* Fix: verify `OPENAI_AZURE_*` values; confirm the deployment exists and API version matches.

---

## FAQ

**Q: Do we need a separate API to connect the UI?**
**A:** Not for this pattern. The browser connects directly to the **Assistant** via **SSE** (`sendMessageStream`). In production, add a **BFF** to keep the **same UI contract** while layering auth, persistence, and observability.

**Q: How does the Assistant find tools?**
**A:** From `AGENT_URLS` (comma-separated base URLs). The Assistant fetches each tool’s `/.well-known/agent.json` (agent card with skills) and keeps an A2A client for delegation.

**Q: What is streamed, exactly?**
**A:** Typed JSON events: `task`, `status-update` (including `input-required`), and `artifact-update` (e.g., `chart.json`, `data.csv`). The UI renders these incrementally.

**Q: Can agents be written in other languages?**
**A:** Yes—any runtime that implements the A2A HTTP + SSE protocol and serves an agent card can participate.

**Q: How do citations work?**
**A:** Tools attach `citations[]`; the Assistant merges them and may add a “Delegation” citation. The UI displays them under **View Sources**.

**Q: Where are tasks stored?**
**A:** This POC uses in-memory stores. For production, persist tasks/HITL bridges in **Redis/DB** and enable recovery on reconnect.

---


