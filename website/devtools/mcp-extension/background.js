const tabEvents = new Map();
const MAX_EVENTS = 200;

function rememberEvent(tabId, event) {
  const queue = tabEvents.get(tabId) ?? [];
  queue.push(event);
  if (queue.length > MAX_EVENTS) {
    queue.splice(0, queue.length - MAX_EVENTS);
  }
  tabEvents.set(tabId, queue);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MCP_CAPTURED_EVENT" && sender.tab?.id) {
    rememberEvent(sender.tab.id, message.event);
    chrome.runtime.sendMessage({ type: "MCP_EVENT_STREAM", tabId: sender.tab.id });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "MCP_GET_EVENTS") {
    const events = tabEvents.get(message.tabId) ?? [];
    sendResponse({ events: [...events].reverse() });
    return true;
  }

  return false;
});
