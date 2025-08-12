// agents/assistant-agent.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import {
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore
} from '@a2a-js/sdk/server';
import { A2AClient } from '@a2a-js/sdk/client';

dotenv.config();

const assistantAgentCard = {
  name: "Assistant Agent",
  description: "Routes to calculator, weather, GraphQL; merges artifacts, adds citations, and maintains light memory.",
  url: "http://localhost:41231/",
  version: "1.6.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain","text/markdown"],
  skills: [
    {
      id: "general_assistant",
      name: "General Assistant",
      description: "Delegates to tools or answers directly.",
      examples: [
        "What's the weather in London tomorrow?",
        "Calculate 25 * 4 + 16",
        "Give me the site with the highest production",
        "query { allSites { name location } }",
        "give me a chart for this",
        "make this into a csv"
      ],
      inputModes: ["text/plain"],
      outputModes: ["text/plain","text/markdown"]
    }
  ]
};

const AZURE_ENDPOINT    = process.env.OPENAI_AZURE_ENDPOINT;
const AZURE_KEY         = process.env.OPENAI_AZURE_KEY;
const AZURE_DEPLOYMENT  = process.env.OPENAI_AZURE_DEPLOYMENT_NAME;
const AZURE_API_VERSION = process.env.OPENAI_AZURE_API_VERSION;
const AZURE_CHAT_ENDPOINT = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;

const AGENT_URLS = (process.env.AGENT_URLS || "")
  .split(",").map(u => u.trim()).filter(Boolean);

class AssistantAgentExecutor {
  constructor(){
    this.cancelled = new Set();
    this.tools = [];             // [{ client, card, url }]
    this.contextMem = {};        // contextId -> { lastTool, lastGraphQLSeen, lastUserTexts[] }
    this.hitlMap = {};           // assistantTaskId -> { client, toolTaskId, toolContextId }
    this.initPromise = this._initTools();
  }
  async _initTools(){
    await Promise.all(AGENT_URLS.map(async url => {
      try {
        const res = await fetch(`${url}/.well-known/agent.json`);
        const card = await res.json();
        const client = new A2AClient(url);
        this.tools.push({ client, card, url });
      } catch(e) { console.warn("Agent discover fail:", url, e?.message); }
    }));
  }
  cancelTask(taskId){ this.cancelled.add(taskId); return Promise.resolve(); }

  _mem(contextId){
    if (!this.contextMem[contextId]) this.contextMem[contextId] = { lastTool:null, lastGraphQLSeen:false, lastUserTexts:[] };
    return this.contextMem[contextId];
  }

  async execute(context, eventBus){
    await this.initPromise;

    const { userMessage, taskId, contextId, task: existing } = context;
    const text = userMessage.parts?.[0]?.text?.trim() || "";
    const mem = this._mem(contextId);

    // Track last N user messages
    mem.lastUserTexts.push(text);
    if (mem.lastUserTexts.length > 10) mem.lastUserTexts.shift();

    // New task event
    if (!existing) {
      eventBus.publish({
        kind: "task", id: taskId, contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage], metadata: userMessage.metadata, artifacts: []
      });
    }

    // HITL continuation? (assistant task being continued)
    if (this.hitlMap[taskId]) {
      const bridge = this.hitlMap[taskId];
      // forward user's message to the tool's task
      const params = {
        message: {
          messageId: uuidv4(),
          role: "user",
          kind: "message",
          taskId: bridge.toolTaskId,
          contextId: bridge.toolContextId,
          parts: userMessage.parts
        },
        configuration: { acceptedOutputModes: ["text/plain","text/markdown","application/json","image/png"], blocking: false }
      };
      const res = await this._proxyToolStream(bridge.client, params, "GraphQL Tool Agent", eventBus, taskId, contextId, /*scrubIds*/true);
      // If completed, clear bridge
      if (res.completed) delete this.hitlMap[taskId];
      eventBus.finished();
      return;
    }

    // Working ping (no parts to avoid UI duplication)
    eventBus.publish({
      kind:"status-update", final:false, taskId, contextId,
      status:{ state:"working", timestamp:new Date().toISOString(),
        message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId, parts: [] } }
    });

    // === Intent selection ===
    const low = text.toLowerCase();

    // Hard heuristics that trump classifier
    const looksGraphQLFollowup =
      /\b(chart|graph|csv|export|file|make this into|visualize|plot|site|compressor)\b/.test(low) ||
      (/\bthis\b/.test(low) && mem.lastTool === "GraphQL Tool Agent");

    let intent = "general";

    if (looksGraphQLFollowup) {
      intent = "graphql";
    } else {
      // Classifier with context memo (helps disambiguate “this”)
      try {
        const memo = `LastTool=${mem.lastTool || "none"}; Recent="${mem.lastUserTexts.slice(-3).join(' | ')}"`;
        const clsPayload = {
          model: AZURE_DEPLOYMENT,
          messages: [
            { role: "system", content:
              "Classify the user's query into one: 'weather', 'calculator', 'graphql', or 'general'. " +
              "Prefer 'graphql' when the user asks for chart/graph/csv/export/site data or references previous data ('this'). " +
              "Context will be provided." },
            { role: "user", content: `Context: ${memo}\nQuery: ${text}` }
          ],
          max_tokens: 4, temperature: 0
        };
        const r = await fetch(AZURE_CHAT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
          body: JSON.stringify(clsPayload)
        });
        if (r.ok) {
          const j = await r.json();
          intent = (j.choices?.[0]?.message?.content || "general").toLowerCase().trim();
        }
      } catch {}
    }

    let finalText = "";
    let mergedCitations = [];
    let finalIntentPath = ["assistant.general_assistant"];

    const delegationCitation = (toolName, skill) => ({
      id: uuidv4(),
      label: "Delegation",
      kind: "internal",
      tool: "Assistant Agent",
      note: `Routed to ${toolName}${skill ? " ("+skill+")":""}`,
      intentPath: ["assistant.general_assistant", `${toolName}.${skill || 'unknown'}`],
      timestamp: new Date().toISOString()
    });

    if (!this.cancelled.has(taskId) && ["weather","calculator","graphql"].includes(intent)) {
      // Select tool by name or skills
      const tool = this.tools.find(t =>
        t.card.name.toLowerCase().includes(intent) ||
        t.card.skills?.some(s => s.id.includes(intent))
      );
      if (tool) {
        // Route to tool; scrub tool IDs in forwarded statuses; capture HITL mapping when needed.
        const prox = await this._proxyToolStream(tool.client, {
          message: { messageId: uuidv4(), role:"user", kind:"message", parts: userMessage.parts },
          configuration: { acceptedOutputModes: ["text/plain","text/markdown","application/json","image/png"], blocking:false }
        }, tool.card.name, eventBus, taskId, contextId, /*scrubIds*/true);

        if (prox.text) finalText += `**${tool.card.name}:** ${prox.text}\n\n`;
        if (prox.cites?.length) mergedCitations.push(...prox.cites);
        mergedCitations.push(delegationCitation(tool.card.name, prox.skill || undefined));
        finalIntentPath = ["assistant.general_assistant", `${tool.card.name}.${prox.skill || 'unknown'}`];

        // Remember last tool
        mem.lastTool = tool.card.name;
        if (tool.card.name === "GraphQL Tool Agent") mem.lastGraphQLSeen = true;
      }
    }

    if (!finalText && intent === "general" && !this.cancelled.has(taskId)) {
      try {
        const payload = { model: AZURE_DEPLOYMENT, messages: [{ role: "user", content: text }] };
        const r = await fetch(AZURE_CHAT_ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
          body: JSON.stringify(payload)
        });
        if (!r.ok) throw new Error(`Azure OpenAI error ${r.status}`);
        const j = await r.json();
        finalText = j.choices?.[0]?.message?.content || "";
        mergedCitations.push({
          id: uuidv4(), label: "LLM (Azure OpenAI)", kind: "model",
          tool: "Assistant Agent", note: `${AZURE_DEPLOYMENT} completion`,
          intentPath: ["assistant.general_assistant"], timestamp: new Date().toISOString()
        });
      } catch (e) {
        finalText = `**Error:** ${e.message}\n\n`;
      }
    }

    if (this.cancelled.has(taskId)) {
      eventBus.publish({
        kind: "status-update", final: true, taskId, contextId,
        status: { state: "cancelled", timestamp: new Date().toISOString(),
          message: { kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId, parts:[{kind:"text", text:"_(Task cancelled)_"}] } }
      });
      eventBus.finished(); return;
    }

    eventBus.publish({
      kind: "status-update", final: true, taskId, contextId,
      status: {
        state: "completed", timestamp: new Date().toISOString(),
        message: {
          kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
          parts: finalText ? [{ kind: "text", text: finalText }] : [],
          citations: mergedCitations,
          intentPath: finalIntentPath
        }
      }
    });
    eventBus.finished();
  }

  // Proxy tool stream -> forward to UI; scrub tool IDs; build HITL bridge when needed

async _proxyToolStream(client, params, toolName, eventBus, assistantTaskId, assistantContextId) {
  let buf = "";
  let collected = [];
  let inferredSkill = null;
  let completed = false;

  const stream = client.sendMessageStream(params);
  for await (const ev of stream) {
    if (ev.kind === "artifact-update") {
      // Pass artifacts through unchanged (assistant IDs)
      eventBus.publish({
        kind: "artifact-update",
        taskId: assistantTaskId,
        contextId: assistantContextId,
        artifact: ev.artifact,
        append: ev.append,
        lastChunk: ev.lastChunk
      });
    } else if (ev.kind === "status-update") {
      const st  = ev.status || {};
      const msg = st.message || {};

      // Track tool skill/intent (if exposed)
      inferredSkill = msg.intent || msg.skillId || inferredSkill;
      const path = ["assistant.general_assistant", `${toolName}.${inferredSkill || 'unknown'}`];

      // Collect citations for merging into ONE final assistant bubble
      if (Array.isArray(msg.citations)) {
        for (const c of msg.citations) {
          collected.push({ ...c, intentPath: c.intentPath || path });
        }
      }

      if (st.state === "completed") {
        // Do NOT forward tool's final text -> avoid duplicate bubbles.
        if (msg?.parts?.length) {
          buf += msg.parts.map(p => p.text || "").join("");
        }
        completed = true;
        continue;
      }

      // *** CRITICAL: restore HITL bridge mapping ***
      // When the tool asks for input, remember its task/context so we can forward the user's reply.
      if (st.state === "input-required") {
        this.hitlMap[assistantTaskId] = {
          client,
          toolTaskId: ev.taskId,      // tool's taskId
          toolContextId: ev.contextId // tool's contextId
        };
      }

      // Forward only non-final statuses (working, input-required) under assistant IDs
      const cleanedMsg = {
        ...msg,
        taskId: assistantTaskId,
        contextId: assistantContextId,
        intentPath: msg.intentPath || path,
        citations: Array.isArray(msg.citations)
          ? msg.citations.map(c => ({ ...c, intentPath: c.intentPath || path }))
          : undefined
      };

      eventBus.publish({
        kind: "status-update",
        taskId: assistantTaskId,
        contextId: assistantContextId,
        status: { ...st, message: cleanedMsg },
        final: false
      });
    }
  }

  return { text: buf, cites: collected, skill: inferredSkill, completed };
}
}

const executor = new AssistantAgentExecutor();
const handler  = new DefaultRequestHandler(assistantAgentCard, new InMemoryTaskStore(), executor);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");
const PORT = process.env.PORT || 41231;
app.listen(PORT, () => console.log(`Assistant Agent listening at http://localhost:${PORT}/`));
