import { Hono } from "hono";
import { env } from "../env";

export const extraRoutes = new Hono();

/* ── Server-side AI info (whether the operator set a key) ───────────── */
extraRoutes.get("/ai/info", (c) => c.json({ serverAi: Boolean(env.OPENAI_API_KEY) }));
