// Minimal stand-in for the payment processor's checkout-session endpoint, so
// the harness can create an order without reaching a real gateway.
// It ONLY mints a session id — it never marks anything paid. Payment is driven
// separately by scripts/harness-pay-order.mjs, which signs the real webhook.
// Development-only. Never used by the deployed app.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const id = "vs_" + randomUUID();
    console.log(`[veyra-stub] ${req.method} ${req.url} -> ${id} :: ${body.slice(0, 200)}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id,
      url: `http://127.0.0.1:59999/hosted/${id}`,
      embed_url: `http://127.0.0.1:59999/embed/${id}`,
    }));
  });
}).listen(59999, "127.0.0.1", () => console.log("[veyra-stub] listening on 127.0.0.1:59999"));
