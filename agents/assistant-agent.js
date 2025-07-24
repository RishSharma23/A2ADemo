// Load dependencies and configuration
require('dotenv').config();  // Load env vars 
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { A2AExpressApp, DefaultRequestHandler, InMemoryTaskStore, A2AClient } = require('@a2a-js/sdk');

// 1. Define the Assistant Agent's Card (public metadata)
const assistantAgentCard = {
  name: "Assistant Orchestrator Agent",
  description: "Orchestrates tasks by delegating to specialized agents (calculator, weather).",
  url: "http://localhost:3000",  // base URL where this agent is hosted
  version: "1.0.0",
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "delegate_task",
      name: "Task Delegation",
      description: "Understands user requests and routes them to other agents (math or weather).",
      examples: ["What’s 2+2?", "Is it sunny in Paris tomorrow?"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }
  ]
};

// 2. Implement the Assistant Agent's execution logic
class AssistantExecutor {
  // Handle incoming task requests
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;  // user's message object
    const queryText = (userMessage.parts[0]?.text || "").toLowerCase();
    const taskId = requestContext.task?.id || uuidv4();
    const contextId = userMessage.contextId || uuidv4();

    // Immediately respond that we're working (streaming feedback)
    eventBus.publish({
      kind: 'status-update',
      taskId, contextId,
      status: {
        state: "working",
        message: { role: "agent", parts: [{ text: "🤖 Assistant: received your request, analyzing..." }] }
      }
    });

    try {
      let resultText;
      if (queryText.match(/weather|forecast/)) {
        // Route to Weather Agent
        eventBus.publish({
          kind: 'status-update', taskId, contextId,
          status: { state: "working",
            message: { role: "agent", parts: [{ text: "➡️ Delegating to Weather Agent..." }] }
          }
        });
        // Use A2AClient to call the Weather Agent's A2A server
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
        // Route to Calculator Agent
        eventBus.publish({
          kind: 'status-update', taskId, contextId,
          status: { state: "working",
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
        // If query not recognized for delegation
        resultText = "I can assist with math or weather questions. Please try asking for a calculation or a weather forecast.";
      }

      // Send final completion message with the result
      eventBus.publish({
        kind: 'status-update',
        taskId, contextId,
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ text: resultText }] }
        }
      });
    } catch (err) {
      console.error("Assistant error:", err);
      // Notify failure
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: { state: "failed",
          message: { role: "agent", parts: [{ text: "⚠️ Failed to process request: " + err }] }
        }
      });
    }
  }

  // Handle cancellation of a task (optional for long tasks)
  async cancelTask(taskId, eventBus) {
    console.log(`Assistant: cancel request for task ${taskId}`);
    // (In a simple demo, we don't maintain long-running state to cancel.)
  }
}

// 3. Set up the Express server with A2A routes
const executor = new AssistantExecutor();
const taskStore = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(assistantAgentCard, taskStore, executor);
const app = express();
app.use(cors());             // enable CORS for browser requests:contentReference[oaicite:7]{index=7}
app.use(express.json());     // parse JSON request bodies
// Serve frontend UI from this server (see frontend setup later)
app.use('/', express.static(__dirname + '/../frontend')); 
// Attach A2A protocol routes to Express
new A2AExpressApp(requestHandler).setupRoutes(app, ''); 

// Start the Assistant agent server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Assistant Agent running at http://localhost:${PORT}`);
  console.log(`Agent Card available at http://localhost:${PORT}/.well-known/agent.json`);
});
