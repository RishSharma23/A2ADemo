require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const {
  A2AExpressApp,
  DefaultRequestHandler,
  InMemoryTaskStore
} = require('@a2a-js/sdk/server');

// 1. Define the Calculator Agent Card
const calcAgentCard = {
  name: "Calculator Agent",
  description: "Solves math problems and arithmetic calculations.",
  url: "http://localhost:3001",
  version: "1.0.0",
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{
    id: "calculate_math",
    name: "Calculator",
    description: "Calculates arithmetic expressions and solves math queries.",
    examples: ["Calculate 5+7", "What is 12 divided by 3?", "Multiplication table of 4"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"]
  }]
};

// 2. Implement the Calculator Executor
class CalculatorExecutor {
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    const text        = userMessage.parts[0]?.text || "";
    const taskId      = requestContext.task?.id || uuidv4();
    const contextId   = userMessage.contextId   || uuidv4();

    // 2a) working update
    eventBus.publish({
      kind: 'status-update', taskId, contextId,
      status: {
        state: "working",
        message: { role: "agent", parts: [{ text: "🧮 Calculating..." }] }
      }
    });

    let result;
    try {
      const cleanExpr = text
        .replace(/[^0-9+\-*/.]/g, " ")
        .replace(/divided by/gi, "/");
      if (!cleanExpr.trim()) throw new Error("No math expression found.");
      // eslint-disable-next-line no-eval
      result = eval(cleanExpr);
    } catch (err) {
      result = `Error: ${err.message}`;
    }

    let responseText = `Result: ${result}`;
    if (text.toLowerCase().includes("table")) {
      const num = parseInt(text.match(/\d+/)?.[0] || NaN);
      if (!isNaN(num)) {
        let table = `Multiplication Table of ${num}:\n`;
        for (let i = 1; i <= 10; i++) {
          table += `${num} x ${i} = ${num * i}\n`;
        }
        eventBus.publish({
          kind: 'artifact-update', taskId, contextId,
          artifact: {
            artifactId: `table-${num}`,
            name: `table_of_${num}.txt`,
            parts: [{ text: table }]
          },
          append: false,
          lastChunk: true
        });
        responseText += " (see attached file for full table)";
      }
    }

    // 2b) completed update
    eventBus.publish({
      kind: 'status-update', taskId, contextId,
      status: {
        state: "completed",
        message: { role: "agent", parts: [{ text: responseText }] }
      }
    });
  }

  async cancelTask(taskId, eventBus) {
    console.log(`Calculator: cancel request for task ${taskId}`);
  }
}

// 3. Wire up Express
const executor       = new CalculatorExecutor();
const taskStore      = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(calcAgentCard, taskStore, executor);
const app            = express();

app.use(cors());

// Only parse JSON for the blocking RPC (/message)
app.post('/message', express.json());

// Mount all A2A routes (including /message/stream)
new A2AExpressApp(requestHandler).setupRoutes(app, '');

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Calculator Agent running at http://localhost:${PORT}`);
  console.log(`Agent Card at http://localhost:${PORT}/.well-known/agent.json`);
});
