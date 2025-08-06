// weather-agent.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import {
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore
} from '@a2a-js/sdk/server';

// Load OPENWEATHER_KEY from .env
dotenv.config();

// 1. Agent card
const weatherAgentCard = {
  name: "Weather Agent",
  description: "Provides weather information for a given location and time.",
  url: "http://localhost:41232/",
  version: "1.1.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "weather_info",
      name: "Weather Information",
      description: "Provides current or forecast weather for a specified city.",
      examples: ["What's the weather in London?", "Forecast for New York tomorrow"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }
  ]
};

// 2. Executor
class WeatherAgentExecutor {
  constructor() {
    this.cancelledTasks = new Set();
  }

  cancelTask(taskId) {
    this.cancelledTasks.add(taskId);
    return Promise.resolve();
  }

  async execute(context, eventBus) {
    const { userMessage, taskId, contextId } = context;
    const isNewTask = !context.task;
    const query = (userMessage.parts[0]?.text || "").trim();

    // 2a. Initial Task event
    if (isNewTask) {
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

    // 2b. Working update
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          taskId,
          contextId,
          parts: [{ kind: "text", text: "Checking weather data..." }]
        },
        timestamp: new Date().toISOString()
      },
      final: false
    });

    // 2c. Extract location from query
    let location = null;
    const inMatch = query.match(/(?:in|for)\s+([A-Za-z\s]+?)(?:\?|$)/i);
    if (inMatch && inMatch[1]) {
      location = inMatch[1].trim();
    } else {
      // fallback: remove common words
      location = query
        .replace(/what('?s)?|weather|forecast|today|tomorrow/gi, "")
        .trim();
    }

    let resultText = "";
    const apiKey = process.env.OPENWEATHER_KEY;
    try {
      if (!location) {
        throw new Error("No location specified in query.");
      }
      if (!apiKey) {
        throw new Error("Missing OPENWEATHER_KEY environment variable.");
      }

      // 2d. Call OpenWeatherMap API
      const res = await fetch(
        `https://api.openweathermap.org/data/2.5/weather` +
        `?q=${encodeURIComponent(location)}` +
        `&units=metric&appid=${apiKey}`
      );

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`OpenWeather error ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      if (data.main && data.weather && data.weather.length) {
        const desc = data.weather[0].description;
        const temp = data.main.temp;
        resultText = `Weather in ${data.name}: ${desc}, ${temp}°C`;
      } else {
        resultText = `Sorry, couldn't find weather for "${location}".`;
      }
    } catch (err) {
      console.error("WeatherAgent error:", err);
      resultText = `Error retrieving weather: ${err.message}`;
    }

    // 2e. Handle cancellation
    if (this.cancelledTasks.has(taskId)) {
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "cancelled",
          message: {
            kind: "message",
            role: "agent",
            messageId: uuidv4(),
            taskId,
            contextId,
            parts: [{ kind: "text", text: "(cancelled)" }]
          },
          timestamp: new Date().toISOString()
        },
        final: true
      });
      eventBus.finished();
      return;
    }

    // 2f. Final response
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
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

// 3. Start the server
const weatherExecutor = new WeatherAgentExecutor();
const weatherHandler  = new DefaultRequestHandler(
  weatherAgentCard,
  new InMemoryTaskStore(),
  weatherExecutor
);

const app = express();
app.use(cors());
new A2AExpressApp(weatherHandler).setupRoutes(app, "");

const PORT = process.env.PORT || 41232;
app.listen(PORT, () => {
  console.log(`Weather Agent listening on http://localhost:${PORT}/`);
});
