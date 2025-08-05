// Load dependencies and configuration
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// SDK server classes
const {
  A2AExpressApp,
  DefaultRequestHandler,
  InMemoryTaskStore
} = require('@a2a-js/sdk/server');

// SDK client (for delegation)
const { A2AClient } = require('@a2a-js/sdk/client');

// Assistant Agent Card
const assistantAgentCard = {
  name: "Assistant Orchestrator Agent",
  description: "Orchestrates tasks by delegating to specialized agents (calculator, weather).",
  url: "http://localhost:3000",
  version: "1.0.0",
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{
    id: "delegate_task",
    name: "Task Delegation",
    description: "Understands user requests and routes them to other agents (math or weather).",
    examples: ["What’s 2+2?", "Is it sunny in Paris tomorrow?"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"]
  }]
};

class AssistantExecutor {
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    const queryText   = (userMessage.parts[0]?.text || "").toLowerCase();
    const taskId      = requestContext.task?.id || uuidv4();
    const contextId   = userMessage.contextId   || uuidv4();

    // 1) initial “working”
    eventBus.publish({
      kind: 'status-update', taskId, contextId,
      status: {
        state: "working",
        message: { role: "agent", parts: [{ text: "🤖 Assistant: received your request, analyzing..." }] }
      }
    });

    try {
      let resultText;

      if (queryText.match(/weather|forecast/)) {
        // 2) delegating…
        eventBus.publish({
          kind: 'status-update', taskId, contextId,
          status: {
            state: "working",
            message: { role: "agent", parts: [{ text: "➡️ Delegating to Weather Agent..." }] }
          }
        });
        const weatherClient = new A2AClient("http://localhost:3002");
        const res = await weatherClient.sendMessage({
          message: {
            messageId: uuidv4(), role: "user", kind: "message",
            parts: [{ kind: "text", text: userMessage.parts[0].text }]
          },
          configuration: { blocking: true, acceptedOutputModes: ["text/plain"] }
        });
        resultText = res.result?.message?.parts?.[0]?.text || "(No response from weather agent)";

      } else if (queryText.match(/calc|calculate|solve|[0-9]/)) {
        eventBus.publish({
          kind: 'status-update', taskId, contextId,
          status: {
            state: "working",
            message: { role: "agent", parts: [{ text: "➡️ Delegating to Calculator Agent..." }] }
          }
        });
        const calcClient = new A2AClient("http://localhost:3001");
        const res = await calcClient.sendMessage({
          message: {
            messageId: uuidv4(), role: "user", kind: "message",
            parts: [{ kind: "text", text: userMessage.parts[0].text }]
          },
          configuration: { blocking: true, acceptedOutputModes: ["text/plain"] }
        });
        resultText = res.result?.message?.parts?.[0]?.text || "(No response from calculator)";

      } else {
        resultText = "I can assist with math or weather questions. Please try asking for a calculation or a weather forecast.";
      }

      // 3) final “completed”
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ text: resultText }] }
        }
      });

      // 4) tell the SDK we’re done so the SSE stream closes
      eventBus.finished();  
      
    } catch (err) {
      console.error("Assistant error:", err);
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: {
          state: "failed",
          message: { role: "agent", parts: [{ text: "⚠️ Failed to process request: " + err }] }
        }
      });
      eventBus.finished();
    }
  }

  async cancelTask(taskId, eventBus) {
    console.log(`Assistant: cancel request for task ${taskId}`);
  }
}

// 5) wire up Express without express.json()
const executor       = new AssistantExecutor();
const taskStore      = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(assistantAgentCard, taskStore, executor);
const app            = express();

app.use(cors());                          // allow browser calls
// app.use(express.json());               // ← removed!

app.use('/', express.static(__dirname + '/../frontend'));
new A2AExpressApp(requestHandler).setupRoutes(app, '');

app.listen(3000, () => {
  console.log(`Assistant Agent running at http://localhost:3000`);
  console.log(`Agent Card at http://localhost:3000/.well-known/agent.json`);
});
