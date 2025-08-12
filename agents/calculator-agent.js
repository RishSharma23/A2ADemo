import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { DefaultRequestHandler, A2AExpressApp, InMemoryTaskStore } from '@a2a-js/sdk/server';

const card = {
  name: "Calculator Agent",
  description: "Performs arithmetic calculations.",
  url: "http://localhost:41233/",
  version: "1.1.0",
  capabilities: { streaming:true, stateTransitionHistory:true },
  defaultInputModes:["text/plain"],
  defaultOutputModes:["text/plain"],
  skills:[{ id:"calculator", name:"Calculator", description:"Basic math", inputModes:["text/plain"], outputModes:["text/plain"] }]
};

class Exec {
  constructor(){ this.cancelled = new Set(); }
  cancelTask(id){ this.cancelled.add(id); return Promise.resolve(); }

  async execute(ctx, eventBus){
    const { userMessage, taskId, contextId, task } = ctx;
    const isNew = !task;
    const raw = (userMessage.parts?.[0]?.text || "").trim();

    if (isNew){
      eventBus.publish({ kind:"task", id:taskId, contextId,
        status:{ state:"submitted", timestamp:new Date().toISOString() },
        history:[userMessage], metadata:userMessage.metadata, artifacts:[] });
    }

   
  eventBus.publish({
  kind:"status-update", final:false, taskId, contextId,
  status:{
    state:"working", timestamp:new Date().toISOString(),
    message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId, parts: [], intent:"calculator" }
  }
  });


    let out;
    try{
      const exprMatch = raw.match(/[0-9+\-*/().^ %]+/g);
      const expr = exprMatch ? exprMatch.join('') : "";
      if (!expr) throw new Error("No valid expression found.");
      if (!/^[0-9+\-*/().^ %\s]+$/.test(expr)) throw new Error("Unsupported characters.");
      const jsExpr = expr.replace(/\^/g, "**");
      const val = Function(`"use strict"; return (${jsExpr});`)();
      if (typeof val !== "number" || Number.isNaN(val)) throw new Error("Not a number.");
      out = `${expr} = ${val}`;
    }catch(e){ out = "Error: " + e.message; }

    if (this.cancelled.has(taskId)){
      eventBus.publish({ kind:"status-update", final:true, taskId, contextId,
        status:{ state:"cancelled", message:{ kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId,
          parts:[{kind:"text", text:"(calculation cancelled)"}], intent:"calculator" } } });
      eventBus.finished(); return;
    }

    eventBus.publish({
      kind:"status-update", final:true, taskId, contextId,
      status:{
        state:"completed", timestamp:new Date().toISOString(),
        message:{
          kind:"message", role:"agent", messageId:uuidv4(), taskId, contextId,
          parts:[{ kind:"text", text: out }],
          intent:"calculator",
          citations: [{
            id: uuidv4(),
            label: "MDN: Operator precedence (JS)",
            url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Operator_precedence",
            kind: "doc",
            tool: "Calculator Agent",
            note: "Expression parsing uses JS precedence (^ mapped to **).",
            timestamp: new Date().toISOString()
          }]
        }
      }
    });
    eventBus.finished();
  }
}

const app = express(); app.use(cors());
new A2AExpressApp(new DefaultRequestHandler(card, new InMemoryTaskStore(), new Exec())).setupRoutes(app, "");
app.listen(41233, ()=>console.log("Calculator Agent http://localhost:41233/"));
