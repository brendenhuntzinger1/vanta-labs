function shouldCapture(url) {
  return typeof url === "string" && url.includes("/api/mcp/");
}

function sendEvent(event) {
  chrome.runtime.sendMessage({ type: "MCP_CAPTURED_EVENT", event }, () => {
    void chrome.runtime.lastError;
  });
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const started = new Date().toISOString();

  if (!shouldCapture(url)) {
    return originalFetch(input, init);
  }

  const requestBody = typeof init?.body === "string" ? init.body : undefined;
  sendEvent({
    timestamp: started,
    transport: "http",
    direction: "request",
    route: url,
    payload: requestBody ? { body: requestBody, method } : { method },
  });

  const response = await originalFetch(input, init);
  const cloned = response.clone();
  const text = await cloned.text().catch(() => "");
  sendEvent({
    timestamp: new Date().toISOString(),
    transport: "http",
    direction: "response",
    route: url,
    payload: {
      status: response.status,
      body: text.slice(0, 5000),
    },
  });
  return response;
};

const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    if (!shouldCapture(String(url))) {
      return;
    }

    sendEvent({
      timestamp: new Date().toISOString(),
      transport: "websocket",
      direction: "event",
      route: String(url),
      payload: { status: "open_requested" },
    });

    this.addEventListener("message", (message) => {
      sendEvent({
        timestamp: new Date().toISOString(),
        transport: "websocket",
        direction: "response",
        route: String(url),
        payload: { data: String(message.data ?? "").slice(0, 5000) },
      });
    });
  }

  send(data) {
    sendEvent({
      timestamp: new Date().toISOString(),
      transport: "websocket",
      direction: "request",
      route: String(this.url),
      payload: { data: String(data ?? "").slice(0, 5000) },
    });
    super.send(data);
  }
};
