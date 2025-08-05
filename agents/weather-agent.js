require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const {
  A2AExpressApp,
  DefaultRequestHandler,
  InMemoryTaskStore
} = require('@a2a-js/sdk/server');

// 1. Define the Weather Agent Card
const weatherAgentCard = {
  name: "Weather Agent",
  description: "Provides current weather and forecasts by querying a weather API.",
  url: "http://localhost:3002",
  version: "1.0.0",
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{
    id: "get_weather",
    name: "Weather Info",
    description: "Fetches weather for a given city or location.",
    examples: ["What's the weather in London?", "Forecast for New York tomorrow"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"]
  }]
};

class WeatherExecutor {
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    const query       = userMessage.parts[0]?.text || "";
    const taskId      = requestContext.task?.id || uuidv4();
    const contextId   = userMessage.contextId   || uuidv4();

    // working update
    eventBus.publish({
      kind: 'status-update', taskId, contextId,
      status: {
        state: "working",
        message: { role: "agent", parts: [{ text: "🌤️ Fetching weather data..." }] }
      }
    });

    try {
      let location = query.replace(/\?/g, '').split(" in ").pop().trim();
      if (!location || location.toLowerCase().includes("weather"))
        location = query
          .replace(/what('|’)s|weather|forecast|the|for|today|tomorrow/gi, "")
          .trim();
      if (!location) throw new Error("No location specified.");

      let weatherInfo;
      const apiKey = process.env.OPENWEATHER_KEY;
      if (apiKey) {
        const res   = await fetch(
          `https://api.openweathermap.org/data/2.5/weather` +
          `?q=${encodeURIComponent(location)}` +
          `&units=metric&appid=${apiKey}`
        );
        const data = await res.json();
        weatherInfo = data.main
          ? `Weather in ${data.name}: ${data.weather[0].description}, ${data.main.temp}°C`
          : `Sorry, couldn't find weather for "${location}".`;
      } else {
        weatherInfo = `Weather in ${location}: sunny, 25°C (demo data)`;
      }

      // completed update
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ text: weatherInfo }] }
        }
      });

    } catch (err) {
      console.error("WeatherAgent error:", err);
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: {
          state: "failed",
          message: { role: "agent", parts: [{ text: "⚠️ Unable to get weather: " + err.message }] }
        }
      });
    }
  }

  async cancelTask(taskId, eventBus) {
    console.log(`Weather: cancel request for task ${taskId}`);
  }
}

// 2. Wire up Express
const executor       = new WeatherExecutor();
const taskStore      = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(weatherAgentCard, taskStore, executor);
const app            = express();

app.use(cors());
app.post('/message', express.json());  // only for blocking RPC

new A2AExpressApp(requestHandler).setupRoutes(app, '');

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Weather Agent running at http://localhost:${PORT}`);
  console.log(`Agent Card at http://localhost:${PORT}/.well-known/agent.json`);
});
