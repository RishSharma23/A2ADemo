// assistant-agent.js
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

//
// 1. Agent Card
//
const assistantAgentCard = {
  name: "Assistant Agent",
  description:
    "An AI assistant that can answer questions, perform calculations, " +
    "check weather, run GraphQL queries, and format responses with citations.",
  url: "http://localhost:41231/",
  version: "1.3.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "text/markdown"],
  skills: [
    {
      id: "general_assistant",
      name: "General Assistant",
      description:
        "Delegates to tools (weather, calculator, GraphQL) or answers directly.",
      examples: [
        "What's the weather in London tomorrow?",
        "Calculate 25 * 4 + 16",
        "query { allSites { name location } }"
      ],
      inputModes: ["text/plain"],
      outputModes: ["text/plain", "text/markdown"]
    }
  ]
};

//
// 2. Azure OpenAI Configuration
//
const AZURE_ENDPOINT      = process.env.OPENAI_AZURE_ENDPOINT;
const AZURE_KEY           = process.env.OPENAI_AZURE_KEY;
const AZURE_DEPLOYMENT    = process.env.OPENAI_AZURE_DEPLOYMENT_NAME;       // "gpt-4.1"
const AZURE_API_VERSION   = process.env.OPENAI_AZURE_API_VERSION;           // "2025-04-14"
const AZURE_CHAT_ENDPOINT = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;

//
// 3. Discovery of tool agents
//
const AGENT_URLS = (process.env.AGENT_URLS || "")
  .split(",")
  .map(u => u.trim())
  .filter(u => u);

class AssistantAgentExecutor {
  constructor() {
    this.cancelled   = new Set();
    this.tools       = [];       // { client, card }
    this.initPromise = this._initTools();
  }

  // Load each agent's card
  async _initTools() {
    await Promise.all(AGENT_URLS.map(async url => {
      try {
        const res  = await fetch(`${url}/.well-known/agent.json`);
        const card = await res.json();
        const client = new A2AClient(url);
        this.tools.push({ client, card });
      } catch (err) {
        console.warn(`Failed to load agent card from ${url}:`, err);
      }
    }));
  }

  cancelTask(taskId) {
    this.cancelled.add(taskId);
    return Promise.resolve();
  }

  async execute(context, eventBus) {
    // Ensure tools are loaded
    await this.initPromise;

    const { userMessage, taskId, contextId, task: existing } = context;
    const text = userMessage.parts[0]?.text?.trim() || "";

    // 4a) Initial task event
    if (!existing) {
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
        metadata: userMessage.metadata,
        artifacts: []
      });
    }

    // 4b) “Working…” update
    eventBus.publish({
      kind: "status-update",
      taskId, contextId,
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          taskId,
          contextId,
          parts: [{ kind: "text", text: "_Assistant is thinking..._" }]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    // 4c) Intent classification via Azure OpenAI
    let intent = "general";
    try {
      const clsPayload = {
        model: AZURE_DEPLOYMENT,
        messages: [
          { role: "system",
            content: "You are an intent classifier. " +
                     "When given a user query, choose exactly one of: weather, calculator, graphql, general." },
          { role: "user", content: `User query: "${text}"` }
        ],
        max_tokens: 1,
        temperature: 0
      };
      const clsRes = await fetch(AZURE_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": AZURE_KEY
        },
        body: JSON.stringify(clsPayload)
      });
      if (clsRes.ok) {
        const clsBody = await clsRes.json();
        intent = clsBody.choices[0].message.content.trim().toLowerCase();
      } else {
        console.warn("Intent classification failed:", await clsRes.text());
      }
    } catch (err) {
      console.error("Intent classification error:", err);
    }

    // 4d) Tool routing
    let answer = "";
    if (!this.cancelled.has(taskId)) {
      if (intent === "weather" || intent === "calculator" || intent === "graphql") {
        // Find matching tool by skill id or name
        const tool = this.tools.find(t =>
          t.card.name.toLowerCase().includes(intent) ||
          t.card.skills.some(s => s.id === intent)
        );
        if (tool) {
          answer = await this._streamAgentResponse(
            tool.client,
            { message: {
                messageId: uuidv4(),
                role: "user",
                kind: "message",
                parts: [{ kind: "text", text }]
              },
              configuration: tool.card.defaultOutputModes.includes("application/json")
                ? { blocking: true, acceptedOutputModes: ["application/json"] }
                : { blocking: true }
            },
            tool.card.name
          );
        }
      }
      // 4e) Fallback to general if no tool response yet
      if (!answer && intent === "general") {
        try {
          const genPayload = {
            model: AZURE_DEPLOYMENT,
            messages: [{ role: "user", content: text }]
          };
          const genRes = await fetch(AZURE_CHAT_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "api-key": AZURE_KEY
            },
            body: JSON.stringify(genPayload)
          });
          if (genRes.ok) {
            const genBody = await genRes.json();
            answer = genBody.choices[0].message.content + "\n\n";
          } else {
            throw new Error(`Azure OpenAI error ${genRes.status}`);
          }
        } catch (err) {
          console.error("Fallback general error:", err);
          answer = `**Error:** ${err.message}\n\n`;
        }
      }
    }

    // 4f) Cancellation check
    if (this.cancelled.has(taskId)) {
      eventBus.publish({
        kind: "status-update",
        taskId, contextId,
        status: {
          state: "cancelled",
          message: {
            kind: "message",
            role: "agent",
            messageId: uuidv4(),
            taskId,
            contextId,
            parts: [{ kind: "text", text: "_(Task cancelled)_" }]
          },
          timestamp: new Date().toISOString()
        },
        final: true
      });
      eventBus.finished();
      return;
    }

    // 4g) Final answer
    eventBus.publish({
      kind: "status-update",
      taskId, contextId,
      status: {
        state: "completed",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          taskId,
          contextId,
          parts: [{ kind: "text", text: answer || "*[No answer]*" }]
        },
        timestamp: new Date().toISOString()
      },
      final: true
    });
    eventBus.finished();
  }

  //
  // Helper: stream a tool’s status‐updates to completion
  //
  async _streamAgentResponse(client, params, label) {
    let buf = "";
    const stream = client.sendMessageStream(params);
    for await (const ev of stream) {
      if (ev.kind === "status-update" && ev.status.message?.parts?.length) {
        buf += ev.status.message.parts.map(p => p.text).join("");
        if (ev.final) break;
      }
    }
    return buf ? `**${label}:** ${buf}\n\n` : "";
  }
}

//
// 5. Express + CORS + A2A setup
//
const executor = new AssistantAgentExecutor();
const handler  = new DefaultRequestHandler(
  assistantAgentCard,
  new InMemoryTaskStore(),
  executor
);

const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");

const PORT = process.env.PORT || 41231;
app.listen(PORT, () => {
  console.log(`Assistant Agent listening at http://localhost:${PORT}/`);
});
