import app from "./app";
import { env } from "./config/env";
import { pool } from "./db/pool";
import { reconcileAllProcessing } from "./services/startupReconcile";

const server = app.listen(env.port, () => {
  console.log(`API running on http://localhost:${env.port}`);
  if (env.reconcileOnStartup) {
    void reconcileAllProcessing()
      .then((report) => {
        console.log("[startup] reconcile PROCESSING:", JSON.stringify(report));
      })
      .catch((error) => {
        console.error("[startup] reconcile failed (API remains up):", error);
      });
  } else {
    console.log("[startup] reconcile on boot disabled (RECONCILE_ON_STARTUP=false)");
  }
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
