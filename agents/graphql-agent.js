// graphql-agent.js
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { buildSchema, graphql } from 'graphql';
import {
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore
} from '@a2a-js/sdk/server';

const graphQLAgentCard = {
  name: "GraphQL Tool Agent",
  description: "Executes GraphQL queries on Petronas data (mocked).",
  url: "http://localhost:41234/",
  version: "1.0.1",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "petronas_data_query",
      name: "Petronas Data Query",
      description: "Query Petronas dataset via GraphQL.",
      examples: [
        'query { site(name: "Alpha") { production } }',
        "query { allSites { name location } }"
      ],
      inputModes: ["text/plain"],
      outputModes: ["application/json"]
    }
  ]
};

const schema = buildSchema(`
  type Site { name: String, location: String, production: Float }
  type Query { site(name: String!): Site, allSites: [Site] }
`);
const mockSites = [
  { name:"Alpha", location:"Malaysia", production:12345.6 },
  { name:"Beta",  location:"Canada",   production:23456.7 },
  { name:"Gamma", location:"Malaysia", production:34567.8 }
];
const root = {
  site: ({ name }) => mockSites.find(s => s.name.toLowerCase() === name.toLowerCase()) || null,
  allSites: () => mockSites
};

class GraphQLAgentExecutor {
  constructor() {
    this.cancelled = new Set();
  }
  cancelTask(taskId) {
    this.cancelled.add(taskId);
    return Promise.resolve();
  }

  async execute(context, eventBus) {
    const { userMessage, taskId, contextId, task } = context;
    const isNew = !task;
    const query = (userMessage.parts[0]?.text || "").trim();

    if (isNew) {
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state:"submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
        metadata: userMessage.metadata,
        artifacts: []
      });
    }

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
          parts: [{ kind:"text", text:"Executing GraphQL query..."}]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    let resultObj;
    try {
      resultObj = await graphql({ schema, source: query, rootValue: root });
    } catch (e) {
      resultObj = { errors:[{ message: e.message }] };
    }

    const outputJson = JSON.stringify(resultObj, null, 2);

    // Artifact update (for downloadable JSON)
    eventBus.publish({
      kind: "artifact-update",
      taskId, contextId,
      artifact: {
        artifactId: "result-json",
        name: "result.json",
        parts: [{ text: outputJson }]
      },
      append: false,
      lastChunk: true
    });

    // Final message with JSON in parts so UI will render it inline
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
          parts: [{ kind:"text", text: outputJson }]
        },
        timestamp: new Date().toISOString()
      },
      final: true
    });
    eventBus.finished();
  }
}

const exec = new GraphQLAgentExecutor();
const handler = new DefaultRequestHandler(
  graphQLAgentCard,
  new InMemoryTaskStore(),
  exec
);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");
app.listen(41234, () => {
  console.log("GraphQL Tool Agent listening on http://localhost:41234/");
});
