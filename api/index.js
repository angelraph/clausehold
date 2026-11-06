// Vercel serverless entry for the Clausehold desk API. Every request is
// routed here (see vercel.json) and handled by the same Express app that
// `clausehold serve` runs locally. The network, storage and service account
// come from the project's environment variables.
import { createApp } from "../dist/src/api/server.js";
import { depsFromConfig } from "../dist/src/api/deps.js";

export default createApp(depsFromConfig());
