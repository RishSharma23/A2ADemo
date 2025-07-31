require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Use server entrypoint for server classes
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
  skills: [
    {
      id: "get_weather",
      name: "Weather Info",
      description: "Fetches weather for a given city or location.",
      examples: ["What's the weather in London?", "Forecast for New York tomorrow"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }
  ]
};

// 2. Implement the Weather Agent logic
class WeatherExecutor {
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    const query = userMessage.parts[0]?.text || "";
    const taskId = requestContext.task?.id || uuidv4();
    const contextId = userMessage.contextId || uuidv4();

    // Immediately notify that Weather agent started processing
    eventBus.publish({
      kind: 'status-update', taskId, contextId,
      status: {
        state: "working",
        message: { role: "agent", parts: [{ text: "🌤️ Fetching weather data..." }] }
      }
    });

    try {
      // Simple parsing: extract location (assume last word is location or contains city name)
      let location = query.replace(/\?/g, '').split(" in ").pop().trim();
      if (!location || location.toLowerCase().includes("weather")) {
        // Fallback: if we couldn't parse via "in", just take the whole query as location
        location = query.replace(/what's|weather|forecast|the|for|today|tomorrow/gi, "").trim();
      }
      if (!location) {
        throw new Error("No location specified.");
      }

      let weatherInfo;
      const apiKey = process.env.OPENWEATHER_KEY;
      /*AS you can see here, A tool can call another LLM as a tool, thus demonstrating an LLM-in-the-middle approach*/
      if (apiKey) {
        // Call real weather API (OpenWeatherMap)
        const apiUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${apiKey}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.main) {
          weatherInfo = `Weather in ${data.name}: ${data.weather[0].description}, Temp ${data.main.temp}°C`;
        } else {
          weatherInfo = `Sorry, I couldn't find weather for "${location}".`;
        }
      } else {
        // No API key: return dummy data
        weatherInfo = `Weather in ${location}: sunny, 25°C (demo data)`;
      }

      // Send the final weather result
      eventBus.publish({
        kind: 'status-update', taskId, contextId,
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ text: weatherInfo }] }
        }
      });
    } catch (err) {
      console.error("WeatherAgent error:", err);
      // Send failure status
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
    // No long-lived task to cancel in this simple agent.
  }
}

// 3. Set up the Weather agent server on port 3002
const executor = new WeatherExecutor();
const taskStore = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(weatherAgentCard, taskStore, executor);
const app = express();
app.use(cors());
app.use(express.json());
new A2AExpressApp(requestHandler).setupRoutes(app, '');

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Weather Agent running at http://localhost:${PORT}`);
  console.log(`Agent Card at http://localhost:${PORT}/.well-known/agent.json`);
});
