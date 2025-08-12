// agents/graphql-agent.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { buildSchema, graphql } from 'graphql';
import {
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore
} from '@a2a-js/sdk/server';

dotenv.config();

// === Agent card (unchanged from your working version) ===
const graphQLAgentCard = {
  name: "GraphQL Tool Agent",
  description: "Executes data queries on a compressor dataset and can format results as JSON, charts, or files.",
  url: "http://localhost:41234/",
  version: "1.1.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "text/markdown", "application/json"],
  skills: [
    {
      id: "compressor_data_query",
      name: "compressor Data Query",
      description: "Query the compressor dataset via GraphQL syntax.",
      examples: [
        'query { site(name: "Alpha") { production } }',
        "query { allSites { name location } }"
      ],
      inputModes: ["text/plain"],
      outputModes: ["application/json"]
    },
    {
      id: "chart_output",
      name: "Chart Generation",
      description: "Generates chart data (JSON schema or image) from query results.",
      examples: ["Show production by location as a chart"],
      inputModes: ["text/plain"],
      outputModes: ["application/json", "image/png"]
    },
    {
      id: "data_file_export",
      name: "Data File Export",
      description: "Exports data results to a downloadable file (e.g., CSV).",
      examples: ["Export the results as a CSV file"],
      inputModes: ["text/plain"],
      outputModes: ["application/json", "application/octet-stream"]
    },
    {
      id: "data_analysis",
      name: "Data Analysis",
      description: "Provides insights or summary of site or compressor data using an LLM.",
      examples: ["Which site has the highest production?"],
      inputModes: ["text/plain"],
      outputModes: ["text/markdown", "text/plain"]
    }
  ]
};

// === Mock schema/data (same as before) ===
const schema = buildSchema(`
  type Site { name: String, location: String, production: Float }
  type Query { site(name: String!): Site, allSites: [Site] }
`);
const mockSites = [
  { name: "Alpha", location: "Malaysia", production: 12345.6 },
  { name: "Beta",  location: "Canada",   production: 23456.7 },
  { name: "Gamma", location: "Malaysia", production: 34567.8 }
];
const root = {
  site: ({ name }) => mockSites.find(s => s.name.toLowerCase() === name.toLowerCase()) || null,
  allSites: () => mockSites
};

// === Azure OpenAI config (for analysis) ===
const AZURE_ENDPOINT    = process.env.OPENAI_AZURE_ENDPOINT;
const AZURE_KEY         = process.env.OPENAI_AZURE_KEY;
const AZURE_DEPLOYMENT  = process.env.OPENAI_AZURE_DEPLOYMENT_NAME;
const AZURE_API_VERSION = process.env.OPENAI_AZURE_API_VERSION;
const AZURE_CHAT_URL    = AZURE_ENDPOINT
  ? `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`
  : null;

class GraphQLAgentExecutor {
  constructor() {
    this.cancelled = new Set();
    this.memoryByContext = {}; // contextId -> { lastResultData }
    this.awaiting = {};        // taskId -> { action, dataArray }
  }
  cancelTask(taskId) { this.cancelled.add(taskId); return Promise.resolve(); }

  async execute(context, eventBus) {
    const { userMessage, taskId, contextId, task } = context;
    const isNew = !task;
    const userText = (userMessage.parts?.[0]?.text || "").trim();

    if (!this.memoryByContext[contextId]) this.memoryByContext[contextId] = {};

    if (isNew) {
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

    // Continuation for HITL confirmation?
    if (this.awaiting[taskId]) {
      const decision = userText.toLowerCase();
      if (/(^y(es)?$)|(^ok$)|approve|proceed/.test(decision)) {
        await this._exportCsv(taskId, contextId, eventBus, this.awaiting[taskId].dataArray, /*attachCites*/true);
        delete this.awaiting[taskId];
        eventBus.finished(); return;
      } else if (/(^n(o)?$)|cancel|stop/.test(decision)) {
        delete this.awaiting[taskId];
        eventBus.publish({
          kind: "status-update", final: true, taskId, contextId,
          status: {
            state: "completed",
            message: {
              kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
              parts: [{ kind: "text", text: "CSV export cancelled." }],
              intent: "data_file_export",
              citations: [{
                id: uuidv4(), label: "Skill: data_file_export", kind: "internal",
                tool: "GraphQL Tool Agent", note: "User declined export", timestamp: new Date().toISOString()
              }]
            }
          }
        });
        eventBus.finished(); return;
      }

      // Ask again clearly
      eventBus.publish({
        kind: "status-update", final: false, taskId, contextId,
        status: {
          state: "input-required",
          message: {
            kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
            parts: [{ kind: "text", text: "Please reply 'yes' or 'no' to confirm the CSV export." }],
            intent: "data_file_export",
            citations: [{
              id: uuidv4(), label: "HITL confirmation", kind: "internal",
              tool: "GraphQL Tool Agent", note: "Disambiguation on export", timestamp: new Date().toISOString()
            }]
          }
        }
      });
      return;
    }

    // Working
    eventBus.publish({
      kind: "status-update", final: false, taskId, contextId,
      status: {
        state: "working", timestamp: new Date().toISOString(),
        message: { kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
          // NOTE: we keep an empty parts array to avoid duplicating 'working' text in UI bubbles
          parts: [],
          intent: "data_analysis"
        }
      }
    });

    // Intent
    const lower = userText.toLowerCase();
    let intent = "data_analysis";
    if (lower.startsWith("query") || userText.trim().startsWith("{")) intent = "compressor_data_query";
    else if (lower.includes("chart") || lower.includes("graph")) intent = "chart_output";
    else if (lower.includes("csv") || lower.includes("file") || lower.includes("download")) intent = "data_file_export";
    else if (/(alpha|beta|gamma)/i.test(userText)) intent = "compressor_data_query";

    try {
      if (intent === "compressor_data_query") {
        const source = userText.startsWith("{") ? userText : `query { allSites { name location production } }`;
        const result = await graphql({ schema, source, rootValue: root });
        if (result?.data) this.memoryByContext[contextId].lastResultData = result.data.allSites ?? result.data.site ?? result.data;

        const outputJson = JSON.stringify(result, null, 2);

        eventBus.publish({
          kind: "artifact-update", taskId, contextId, append: false, lastChunk: true,
          artifact: {
            artifactId: "result-json",
            name: "result.json",
            mimeType: "application/json",
            parts: [{ kind: "text", text: outputJson }],
            citations: [
              { id: uuidv4(), label: "Dataset: mockSites", kind: "internal", tool: "GraphQL Tool Agent", note: "In-memory mock data", timestamp: new Date().toISOString() },
              { id: uuidv4(), label: "Skill: compressor_data_query", kind: "internal", tool: "GraphQL Tool Agent", note: "Executed GraphQL query", timestamp: new Date().toISOString() }
            ]
          }
        });

        eventBus.publish({
          kind: "status-update", final: true, taskId, contextId,
          status: {
            state: "completed",
            message: {
              kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
              parts: [{ kind: "text", text: outputJson }],
              intent: "compressor_data_query",
              citations: [
                { id: uuidv4(), label: "GraphQL spec (query language)", url: "https://spec.graphql.org/", kind: "doc", tool: "GraphQL Tool Agent", note: "Query evaluation", timestamp: new Date().toISOString() }
              ]
            }
          }
        });
        eventBus.finished(); return;
      }

      if (intent === "chart_output") {
        const data = this.memoryByContext[contextId].lastResultData || mockSites;
        const labels = data.map(s => s.name);
        const values = data.map(s => s.production);
        const chart = {
          type: "bar",
          data: { labels, datasets: [{ label: "Production", data: values }] },
          options: { responsive: true, plugins: { title: { display: true, text: "Production Chart" } } }
        };
        const chartJson = JSON.stringify({ type: "chartjs", chart }, null, 2);

        eventBus.publish({
          kind: "artifact-update", taskId, contextId, append: false, lastChunk: true,
          artifact: {
            artifactId: "chart-data",
            name: "chart.json",
            mimeType: "application/json",
            parts: [{ kind: "text", text: chartJson }],
            citations: [
              { id: uuidv4(), label: "Dataset: mockSites", kind: "internal", tool: "GraphQL Tool Agent", note: "Chart built from mock data", timestamp: new Date().toISOString() },
              { id: uuidv4(), label: "Skill: chart_output", kind: "internal", tool: "GraphQL Tool Agent", note: "Chart generation skill used", timestamp: new Date().toISOString() }
            ]
          }
        });

        eventBus.publish({
          kind: "status-update", final: true, taskId, contextId,
          status: {
            state: "completed",
            message: {
              kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
              parts: [{ kind: "text", text: "Chart generated from the data." }],
              intent: "chart_output",
              citations: [
                { id: uuidv4(), label: "Chart.js docs", url: "https://www.chartjs.org/docs/latest/", kind: "doc", tool: "GraphQL Tool Agent", note: "Chart configuration", timestamp: new Date().toISOString() }
              ]
            }
          }
        });
        eventBus.finished(); return;
      }

      if (intent === "data_file_export") {
        const data = this.memoryByContext[contextId].lastResultData || mockSites;
        const rows = Array.isArray(data) ? data.length : (data ? 1 : 0);

        // HITL confirmation
        this.awaiting[taskId] = { action: "exportCsv", dataArray: Array.isArray(data) ? data : [data] };
        eventBus.publish({
          kind: "status-update", final: false, taskId, contextId,
          status: {
            state: "input-required",
            message: {
              kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
              parts: [{ kind: "text", text: `About to export ${rows} row(s) to CSV. Proceed? (yes/no)` }],
              intent: "data_file_export",
              citations: [
                { id: uuidv4(), label: "Skill: data_file_export", kind: "internal", tool: "GraphQL Tool Agent", note: "Export requires confirmation", timestamp: new Date().toISOString() }
              ]
            }
          }
        });
        return;
      }

      // data_analysis (LLM)
      const data = this.memoryByContext[contextId].lastResultData || mockSites;
      if (!AZURE_CHAT_URL || !AZURE_KEY) throw new Error("LLM not configured.");
      const payload = {
        messages: [
          { role: "system", content: "Answer based strictly on the provided data." },
          { role: "user", content: `Data: ${JSON.stringify(data)}\nQuestion: ${userText}` }
        ],
        max_tokens: 200, temperature: 0.4
      };
      const r = await fetch(AZURE_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(`Azure OpenAI ${r.status}: ${await r.text()}`);
      const j = await r.json();
      const txt = j.choices?.[0]?.message?.content || "No answer.";

      eventBus.publish({
        kind: "status-update", final: true, taskId, contextId,
        status: {
          state: "completed",
          message: {
            kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
            parts: [{ kind: "text", text: txt }],
            intent: "data_analysis",
            citations: [
              { id: uuidv4(), label: "Dataset: mockSites", kind: "internal", tool: "GraphQL Tool Agent", note: "Source data for analysis", timestamp: new Date().toISOString() },
              { id: uuidv4(), label: "LLM (Azure OpenAI)", kind: "model", tool: "GraphQL Tool Agent", note: `${AZURE_DEPLOYMENT} completion`, timestamp: new Date().toISOString() }
            ]
          }
        }
      });
      eventBus.finished(); return;

    } catch (e) {
      eventBus.publish({
        kind: "status-update", final: true, taskId, contextId,
        status: {
          state: "completed",
          message: {
            kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
            parts: [{ kind: "text", text: `**Error:** ${e.message}` }],
            intent
          }
        }
      });
      eventBus.finished();
    }
  }

  async _exportCsv(taskId, contextId, eventBus, dataArray, attachCites) {
    const headers = Object.keys(dataArray[0] || {});
    const csvRows = [headers.join(',')];
    for (const item of dataArray) {
      csvRows.push(headers.map(h => {
        const v = item?.[h];
        return (v === undefined || v === null) ? "" : String(v).replace(/,/g, ';');
      }).join(','));
    }
    const csvBase64 = Buffer.from(csvRows.join('\n'), 'utf-8').toString('base64');

    eventBus.publish({
      kind: "artifact-update", taskId, contextId, append: false, lastChunk: true,
      artifact: {
        artifactId: "data-csv", name: "data.csv", mimeType: "text/csv",
        parts: [{ base64: csvBase64 }],
        citations: attachCites ? [
          { id: uuidv4(), label: "Dataset: mockSites", kind: "internal", tool: "GraphQL Tool Agent", note: "CSV rows from mock data", timestamp: new Date().toISOString() },
          { id: uuidv4(), label: "Skill: data_file_export", kind: "internal", tool: "GraphQL Tool Agent", note: "CSV written server-side", timestamp: new Date().toISOString() }
        ] : undefined
      }
    });

    eventBus.publish({
      kind: "status-update", final: true, taskId, contextId,
      status: {
        state: "completed",
        message: {
          kind: "message", role: "agent", messageId: uuidv4(), taskId, contextId,
          parts: [{ kind: "text", text: "Exported data to CSV file." }],
          intent: "data_file_export",
          citations: attachCites ? [
            { id: uuidv4(), label: "Skill: data_file_export", kind: "internal", tool: "GraphQL Tool Agent", note: "Export confirmed by user", timestamp: new Date().toISOString() }
          ] : undefined
        }
      }
    });
  }
}

const exec = new GraphQLAgentExecutor();
const handler = new DefaultRequestHandler(graphQLAgentCard, new InMemoryTaskStore(), exec);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");
app.listen(41234, () => console.log("GraphQL Tool Agent listening on http://localhost:41234/"));
