const eventsRoot = document.getElementById("events");
const refreshButton = document.getElementById("refresh");

function render(events) {
  eventsRoot.replaceChildren();
  for (const event of events) {
    const item = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${event.timestamp} • ${event.transport} • ${event.direction} • ${event.route}`;
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(event.payload, null, 2);
    item.append(meta, payload);
    eventsRoot.append(item);
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }
  chrome.runtime.sendMessage({ type: "MCP_GET_EVENTS", tabId: tab.id }, (response) => {
    const events = Array.isArray(response?.events) ? response.events : [];
    render(events);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MCP_EVENT_STREAM") {
    refresh().catch(() => {});
  }
});

refreshButton?.addEventListener("click", () => {
  refresh().catch(() => {});
});

refresh().catch(() => {});
