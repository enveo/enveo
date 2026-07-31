import { Hono } from "hono";
import { env } from "../env";

export const extraRoutes = new Hono();

 
extraRoutes.get("/ai/info", (c) => c.json({ serverAi: Boolean(env.OPENAI_API_KEY) }));
