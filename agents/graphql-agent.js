// graphql-agent.js
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

// Load environment variables (Azure / OpenAI credentials, etc.)
dotenv.config();

// 1. Agent Card with expanded capabilities
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
      description: "Provides insights or summary of data using an LLM.",
      examples: ["Which site has the highest production?"],
      inputModes: ["text/plain"],
      outputModes: ["text/markdown", "text/plain"]
    }
  ]
};

// 2. GraphQL schema and mock dataset
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

// 3. Azure OpenAI (GPT-4) configuration for data analysis
const AZURE_ENDPOINT    = process.env.OPENAI_AZURE_ENDPOINT;
const AZURE_KEY         = process.env.OPENAI_AZURE_KEY;
const AZURE_DEPLOYMENT  = process.env.OPENAI_AZURE_DEPLOYMENT_NAME;
const AZURE_API_VERSION = process.env.OPENAI_AZURE_API_VERSION;
const AZURE_CHAT_URL    = AZURE_ENDPOINT 
  ? `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`
  : null;

// 4. GraphQL Agent Executor with multi-turn memory
class GraphQLAgentExecutor {
  constructor() {
    this.cancelled = new Set();
    this.memory = {};  // Stores context-specific data for multi-turn interactions
  }

  cancelTask(taskId) {
    this.cancelled.add(taskId);
    return Promise.resolve();
  }

  async execute(context, eventBus) {
    const { userMessage, taskId, contextId, task } = context;
    const isNew = !task;
    const userText = (userMessage.parts[0]?.text || "").trim();

    // Initialize memory for this context if not already present
    if (!this.memory[contextId]) {
      this.memory[contextId] = {};
    }

    // (a) Publish initial task event on new tasks
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

    // (b) Send a "working" status update
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
          parts: [{ kind: "text", text: "_Processing your request..._" }]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    // (c) Determine user intent (query vs chart vs file vs analysis)
    let intent = "analysis";  // default to analysis for natural language questions
    const lower = userText.toLowerCase();
    if (lower.startsWith("query") || userText.startsWith("{")) {
      intent = "graphql";
    } else if (lower.includes("chart") || lower.includes("graph")) {
      intent = "chart";
    } else if (lower.includes("csv") || lower.includes("file") || lower.includes("download")) {
      intent = "file";
    } else if (/(alpha|beta|gamma)/i.test(userText)) {
      // If user input references a known site name without a full query
      intent = "site";
    }
    // (Note: 'analysis' will cover any other questions about the data.)

    let finalTextOutput = "";  // will hold any text response to send back in the final message
    try {
      if (intent === "graphql") {
        // **GraphQL Query Execution**
        const resultObj = await graphql({ schema, source: userText, rootValue: root });
        // Save result in memory for follow-ups
        if (resultObj.data) {
          this.memory[contextId].lastResultData = resultObj.data.allSites ?? resultObj.data.site ?? resultObj.data;
        }
        const outputJson = JSON.stringify(resultObj, null, 2);
        // Send JSON result as a downloadable artifact
        eventBus.publish({
          kind: "artifact-update",
          taskId, contextId,
          artifact: {
            artifactId: "result-json",
            name: "result.json",
            mimeType: "application/json",
            parts: [{ kind: "text", text: outputJson }]
          },
          append: false,
          lastChunk: true
        });
        // Also include JSON text in final message so it's visible in chat
        finalTextOutput = outputJson;
      }
      else if (intent === "site") {
        // **Single Site Query (inferred from name)**
        // Construct a GraphQL query for the specified site name
        const nameMatch = userText.match(/Alpha|Beta|Gamma/i);
        const siteName = nameMatch ? nameMatch[0] : "";
        const query = `query { site(name: "${siteName}") { name location production } }`;
        const resultObj = await graphql({ schema, source: query, rootValue: root });
        if (resultObj.data) {
          this.memory[contextId].lastResultData = resultObj.data.site;
        }
        const outputJson = JSON.stringify(resultObj, null, 2);
        // We choose to just return the JSON in the message (small result), but could also send an artifact
        finalTextOutput = outputJson;
      }
      else if (intent === "chart") {
        // **Chart Generation**
        // Use last result data if available; otherwise fall back to full dataset
        let dataArray;
        if (this.memory[contextId].lastResultData) {
          dataArray = Array.isArray(this.memory[contextId].lastResultData)
            ? this.memory[contextId].lastResultData 
            : [ this.memory[contextId].lastResultData ];
        } else {
          dataArray = mockSites;
        }
        // Prepare chart data series
        let labels = [], values = [];
        if (lower.includes("location")) {
          // User wants data aggregated by location (country)
          const totals = {};
          dataArray.forEach(site => {
            if (!site) return;
            const loc = site.location || "Unknown";
            const prod = site.production || 0;
            totals[loc] = (totals[loc] || 0) + prod;
          });
          labels = Object.keys(totals);
          values = Object.values(totals);
        } else {
          // One bar per site
          labels = dataArray.map(site => site.name);
          values = dataArray.map(site => site.production);
        }
        // Create a Chart.js configuration object
        const chartConfig = {
          type: "bar",
          data: {
            labels: labels,
            datasets: [{ label: "Production", data: values }]
          },
          options: {
            responsive: true,
            title: { display: true, text: "Production Chart" }
          }
        };
        // Wrap in a JSON marker so the UI knows this is chart data
        const chartData = { type: "chartjs", chart: chartConfig };
        const chartJson = JSON.stringify(chartData, null, 2);
        // Send chart spec as a DataPart artifact (JSON)
        eventBus.publish({
          kind: "artifact-update",
          taskId, contextId,
          artifact: {
            artifactId: "chart-data",
            name: "chart.json",
            mimeType: "application/json",
            parts: [{ kind: "text", text: chartJson }]
          },
          append: false,
          lastChunk: true
        });
        // Provide a brief confirmation in text
        finalTextOutput = "Chart generated from the data.";
      }
      else if (intent === "file") {
        // **File Export (CSV)**
        let dataArray;
        if (this.memory[contextId].lastResultData) {
          dataArray = Array.isArray(this.memory[contextId].lastResultData)
            ? this.memory[contextId].lastResultData
            : [ this.memory[contextId].lastResultData ];
        } else {
          dataArray = mockSites;
        }
        if (!dataArray.length) {
          throw new Error("No data available to export.");
        }
        // Convert data to CSV format (commas, with header row)
        const headers = Object.keys(dataArray[0]);
        const csvRows = [ headers.join(',') ];
        for (const item of dataArray) {
          const values = headers.map(h => {
            let val = item[h];
            // Convert undefined/null to empty, and replace any commas in values to avoid breaking CSV format
            return (val === undefined || val === null) ? "" : val.toString().replace(/,/g, ';');
          });
          csvRows.push(values.join(','));
        }
        const csvContent = csvRows.join('\n');
        // Encode CSV text to base64 for sending as FilePart
        const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');
        eventBus.publish({
          kind: "artifact-update",
          taskId, contextId,
          artifact: {
            artifactId: "data-csv",
            name: "data.csv",
            mimeType: "text/csv",
            parts: [{ base64: csvBase64 }]
          },
          append: false,
          lastChunk: true
        });
        finalTextOutput = "Exported data to CSV file.";
      }
      else if (intent === "analysis") {
        // **Data Analysis via LLM**
        let dataForAnalysis;
        if (this.memory[contextId].lastResultData) {
          dataForAnalysis = this.memory[contextId].lastResultData;
        } else {
          dataForAnalysis = mockSites;
        }
        const question = userText;
        const dataSnippet = JSON.stringify(dataForAnalysis);
        // Construct a prompt giving the data and the question to the AI
        const messages = [
          { role: "system", content: "You are a data analyst assistant. Answer the user's question based on the provided data." },
          { role: "user", content: `Data: ${dataSnippet}\nQuestion: ${question}` }
        ];
        if (!AZURE_CHAT_URL || !AZURE_KEY) {
          throw new Error("LLM analysis requested but Azure OpenAI is not configured.");
        }
        const payload = { messages, max_tokens: 200, temperature: 0.7 };
        const apiRes = await fetch(AZURE_CHAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
          body: JSON.stringify(payload)
        });
        if (!apiRes.ok) {
          const errText = await apiRes.text();
          throw new Error(`Azure OpenAI error ${apiRes.status}: ${errText}`);
        }
        const apiJson = await apiRes.json();
        const answerText = apiJson.choices[0].message.content;
        finalTextOutput = answerText;
      }
    } catch (err) {
      console.error("GraphQLAgent error:", err);
      finalTextOutput = `**Error:** ${err.message}`;
    }

    // (d) If task was cancelled mid-way, handle that
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
            parts: [{ kind: "text", text: "_(cancelled)_"}]
          },
          timestamp: new Date().toISOString()
        },
        final: true
      });
      eventBus.finished();
      return;
    }

    // (e) Send final completion status with any text output
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
          parts: finalTextOutput 
            ? [{ kind: "text", text: finalTextOutput }]
            : []
        },
        timestamp: new Date().toISOString()
      },
      final: true
    });
    eventBus.finished();
  }
}

// 5. Start Express server with A2A routes
const exec = new GraphQLAgentExecutor();
const handler = new DefaultRequestHandler(graphQLAgentCard, new InMemoryTaskStore(), exec);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");

app.listen(41234, () => {
  console.log("GraphQL Tool Agent listening on http://localhost:41234/");
});
