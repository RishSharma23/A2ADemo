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
    "check weather, run GraphQL data queries, and format responses with citations.",
  url: "http://localhost:41231/",
  version: "1.4.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "text/markdown"],
  skills: [
    {
      id: "general_assistant",
      name: "General Assistant",
      description: "Delegates to tools (weather, calculator, GraphQL) or answers directly.",
      examples: [
        "What's the weather in London tomorrow?",
        "Calculate 25 * 4 + 16",
        "query { allSites { name location } }",
        "Show a chart of production by location"
      ],
      inputModes: ["text/plain"],
      outputModes: ["text/plain", "text/markdown"]
    }
  ]
};

//
// 2. Azure OpenAI Configuration
//
const AZURE_ENDPOINT    = process.env.OPENAI_AZURE_ENDPOINT;
const AZURE_KEY         = process.env.OPENAI_AZURE_KEY;
const AZURE_DEPLOYMENT  = process.env.OPENAI_AZURE_DEPLOYMENT_NAME;  // e.g. "gpt-4"
const AZURE_API_VERSION = process.env.OPENAI_AZURE_API_VERSION;
const AZURE_CHAT_ENDPOINT = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;

//
// 3. Discover tool agents (from AGENT_URLS in .env)
//
const AGENT_URLS = (process.env.AGENT_URLS || "")
  .split(",")
  .map(u => u.trim())
  .filter(u => u);

class AssistantAgentExecutor {
  constructor() {
    this.cancelled = new Set();
    this.tools = [];
    this.initPromise = this._initTools();
  }

  async _initTools() {
    // Load each agent's card for capability matching
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
    // Ensure tools are loaded (wait for _initTools if still in progress)
    await this.initPromise;

    const { userMessage, taskId, contextId, task: existing } = context;
    const text = userMessage.parts[0]?.text?.trim() || "";

    // 4a) Initial task event (only if a brand new task)
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

    // 4b) "Assistant is thinking..." intermediate status
    eventBus.publish({
      kind: "status-update",
      taskId, contextId,
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          taskId, contextId,
          parts: [{ kind: "text", text: "_Assistant is thinking..._" }]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    // 4c) Intent Classification via Azure OpenAI
    let intent = "general";
    try {
      const clsPayload = {
        model: AZURE_DEPLOYMENT,
        messages: [
          { role: "system", content:
              "You are an intent classifier. Decide which tool or category the user's query belongs to. " +
              "Choose exactly one of: 'weather' (weather info queries), 'calculator' (math calculations), " +
              "'graphql' (data queries, charts, or file exports about compressoronas sites), or 'general' (anything else)." },
          { role: "user", content: `User query: "${text}"` }
        ],
        max_tokens: 1,
        temperature: 0
      };
      const clsRes = await fetch(AZURE_CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
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

    // 4d) Route to the appropriate tool agent if applicable
    let answer = "";
    if (!this.cancelled.has(taskId)) {
      if (intent === "weather" || intent === "calculator" || intent === "graphql") {
        // Find the corresponding tool agent by intent name or skill id
        const tool = this.tools.find(t =>
          t.card.name.toLowerCase().includes(intent) ||
          t.card.skills.some(s => s.id === intent)
        );
        if (tool) {
          // Prepare message params. If the tool can return JSON, allow JSON output (for GraphQL).
          const params = {
            message: {
              messageId: uuidv4(),
              role: "user",
              kind: "message",
              parts: [{ kind: "text", text }]
            },
            configuration: tool.card.defaultOutputModes.includes("application/json")
              ? { blocking: true, acceptedOutputModes: ["text/plain", "text/markdown", "application/json", "image/png"] }
              : { blocking: true }
          };
          answer = await this._streamAgentResponse(tool.client, params, tool.card.name, eventBus, taskId, contextId);
        }
      }
      // 4e) If no answer yet and intent is general, use GPT-4 directly for an answer
      if (!answer && intent === "general") {
        try {
          const genPayload = {
            model: AZURE_DEPLOYMENT,
            messages: [ { role: "user", content: text } ]
          };
          const genRes = await fetch(AZURE_CHAT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
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

    // 4f) Check cancellation once more before finalizing
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
            taskId, contextId,
            parts: [{ kind: "text", text: "_(Task cancelled)_" }]
          },
          timestamp: new Date().toISOString()
        },
        final: true
      });
      eventBus.finished();
      return;
    }

    // 4g) Send final answer (if answer is empty, show a placeholder)
    eventBus.publish({
      kind: "status-update",
      taskId, contextId,
      status: {
        state: "completed",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          taskId, contextId,
          parts: [{ kind: "text", text: answer || "*[No answer]*" }]
        },
        timestamp: new Date().toISOString()
      },
      final: true
    });
    eventBus.finished();
  }

  // Helper: Stream a tool agent's response (status updates and artifacts) and return final text
  async _streamAgentResponse(client, params, label, eventBus, taskId, contextId) {
    let buf = "";
    const stream = client.sendMessageStream(params);
    for await (const ev of stream) {
      if (ev.kind === "artifact-update") {
        // Forward file/image/data artifacts to the UI via our eventBus
        eventBus.publish({
          kind: "artifact-update",
          taskId, contextId,
          artifact: ev.artifact,
          append: ev.append,
          lastChunk: ev.lastChunk
        });
      } else if (ev.kind === "status-update" && ev.status.message?.parts?.length) {
        buf += ev.status.message.parts.map(p => p.text).join("");
        if (ev.final) break;
      }
    }
    // Return accumulated text prefixed with the tool label (for final message)
    return buf ? `**${label}:** ${buf}\n\n` : "";
  }
}

//
// 5. Express + CORS + A2A setup
//
const executor = new AssistantAgentExecutor();
const handler  = new DefaultRequestHandler(assistantAgentCard, new InMemoryTaskStore(), executor);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");

const PORT = process.env.PORT || 41231;
app.listen(PORT, () => {
  console.log(`Assistant Agent listening at http://localhost:${PORT}/`);
});
