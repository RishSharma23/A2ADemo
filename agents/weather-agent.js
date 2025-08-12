import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { DefaultRequestHandler, A2AExpressApp, InMemoryTaskStore } from '@a2a-js/sdk/server';

dotenv.config();

const card = {
  name: "Weather Agent",
  description: "Provides current weather by city.",
  url: "http://localhost:41232/",
  version: "1.2.0",
  capabilities:{ streaming:true, stateTransitionHistory:true },
  defaultInputModes:["text/plain"],
  defaultOutputModes:["text/plain"],
  skills:[{ id:"weather_info", name:"Weather Information", description:"Current weather", inputModes:["text/plain"], outputModes:["text/plain"] }]
};

class Exec {
  constructor(){ this.cancelled = new Set(); }
  cancelTask(id){ this.cancelled.add(id); return Promise.resolve(); }

  async execute(ctx, eventBus){
    const { userMessage, taskId, contextId, task } = ctx;
    const isNew = !task;
    const query = (userMessage.parts?.[0]?.text || "").trim();

    if (isNew){
      eventBus.publish({ kind:"task", id:taskId, contextId,
        status:{ state:"submitted", timestamp:new Date().toISOString() },
        history:[userMessage], metadata:userMessage.metadata, artifacts:[] });
    }

    eventBus.publish({
      kind:"status-update", final:false, taskId, contextId,
      status:{ state:"working",
        message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId,
          parts:[{kind:"text", text:"Checking weather data..."}], intent:"" } }
    });
   /* eventBus.publish({
  kind:"status-update", final:false, taskId, contextId,
  status:{
    state:"working", timestamp:new Date().toISOString(),
    message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId, parts: [], intent:"weather_info" }
  }
});*/


    let location = null;
    const m = query.match(/(?:in|for)\s+([A-Za-z\s]+?)(?:\?|$)/i);
    location = m?.[1]?.trim() || query.replace(/what('?s)?|weather|forecast|today|tomorrow/gi,"").trim();

    const apiKey = process.env.OPENWEATHER_KEY;
    let textOut;
    try{
      if (!location) throw new Error("No location specified.");
      if (!apiKey) throw new Error("Missing OPENWEATHER_KEY.");

      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${apiKey}`;
      const r = await fetch(url);
      if (!r.ok){ throw new Error(`OpenWeather error ${r.status}: ${await r.text()}`); }
      const data = await r.json();
      if (data.main && data.weather?.length){
        const desc = data.weather[0].description; const temp = data.main.temp;
        textOut = `Weather in ${data.name}: ${desc}, ${temp}°C`;
      } else {
        textOut = `Sorry, couldn't find weather for "${location}".`;
      }

      eventBus.publish({
        kind:"status-update", final:true, taskId, contextId,
        status:{
          state:"completed", timestamp:new Date().toISOString(),
          message:{
            kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId,
            parts:[{kind:"text", text: textOut}], intent:"weather_info",
            citations: [
              {
                id: uuidv4(),
                label: "OpenWeather Current Weather API",
                url: "https://openweathermap.org/current",
                kind: "api-doc",
                tool: "Weather Agent",
                note: "Endpoint used for current conditions.",
                timestamp: new Date().toISOString()
              },
              {
                id: uuidv4(),
                label: "OpenWeather request (redacted key)",
                url: `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric`,
                kind: "api",
                tool: "Weather Agent",
                note: "GET with city name & metric units.",
                timestamp: new Date().toISOString()
              }
            ]
          }
        }
      });
      eventBus.finished();
    }catch(e){
      eventBus.publish({
        kind:"status-update", final:true, taskId, contextId,
        status:{ state:"completed",
          message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId,
            parts:[{kind:"text", text:`Error retrieving weather: ${e.message}`}], intent:"weather_info" } }
      });
      eventBus.finished();
    }
  }
}

const app = express(); app.use(cors());
new A2AExpressApp(new DefaultRequestHandler(card, new InMemoryTaskStore(), new Exec())).setupRoutes(app, "");
const PORT = process.env.PORT || 41232;
app.listen(PORT, ()=>console.log(`Weather Agent http://localhost:${PORT}/`));
