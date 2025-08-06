// calculator-agent.js
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import {
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore
} from '@a2a-js/sdk/server';

const calculatorAgentCard = {
  name: "Calculator Agent",
  description: "Performs arithmetic calculations from text queries.",
  url: "http://localhost:41233/",
  version: "1.0.1",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "calculator",
      name: "Calculator",
      description: "Solves math expressions, including exponentiation with ^.",
      examples: ["What is 25 * 4 + 16?", "calculate 2^5", "3+5"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }
  ]
};

class CalculatorAgentExecutor {
  constructor() {
    this.cancelledTasks = new Set();
  }
  cancelTask(taskId) {
    this.cancelledTasks.add(taskId);
    return Promise.resolve();
  }

  async execute(context, eventBus) {
    const { userMessage, taskId, contextId, task } = context;
    const isNew = !task;
    const expr = (userMessage.parts[0]?.text || "").trim();

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
          parts: [{ kind: "text", text: "Crunching numbers..." }]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    // Evaluate safely: allow digits, + - * / . ^ % and spaces
    let resultText;
    try {
      if (!/^[0-9+\-*/().^ %\s]+$/.test(expr))
        throw new Error("Unsupported characters in expression");
      // Replace ALL '^' with '**' for exponentiation
      const jsExpr = expr.replace(/\^/g, "**");
      const val = Function(`"use strict"; return (${jsExpr});`)();
      resultText = `${expr} = ${val}`;
    } catch (e) {
      resultText = "Error: " + e.message;
    }

    if (this.cancelledTasks.has(taskId)) {
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
            parts: [{ kind: "text", text: "(calculation cancelled)" }]
          },
          timestamp: new Date().toISOString()
        },
        final: true
      });
      eventBus.finished();
      return;
    }

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
          parts: [{ kind: "text", text: resultText }]
        },
        timestamp: new Date().toISOString()
      },
      final: true
    });
    eventBus.finished();
  }
}

// Server bootstrap
const exec = new CalculatorAgentExecutor();
const handler = new DefaultRequestHandler(
  calculatorAgentCard,
  new InMemoryTaskStore(),
  exec
);
const app = express();
app.use(cors());
new A2AExpressApp(handler).setupRoutes(app, "");
app.listen(41233, () => {
  console.log("Calculator Agent listening on http://localhost:41233/");
});
