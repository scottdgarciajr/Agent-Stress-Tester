// background/service_worker.js
// Service worker: handles Ollama API calls, classification, report generation,
// and message routing between popup and content scripts.

// test_suites.js is NOT imported here — the SW receives suite objects as message
// payloads from the content script and never needs to reference SUITES directly.
importScripts(
  '../lib/ollama.js',
  '../lib/classifier.js',
  '../lib/reporter.js'
);

let ollamaClient = new OllamaClient('http://localhost:11434', 'llama3');
let popupTabId = null;

// Relay progress to popup
function relayToPopup(msg) {
  if (popupTabId !== null) {
    chrome.tabs.sendMessage(popupTabId, msg).catch(() => {});
  }
  // Also send to extension popup via runtime
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'REGISTER_POPUP':
        popupTabId = msg.tabId || null;
        sendResponse({ ok: true });
        break;

      case 'CHECK_OLLAMA': {
        ollamaClient = new OllamaClient(msg.baseUrl || 'http://localhost:11434', msg.model || 'llama3');
        const result = await ollamaClient.checkConnection();
        sendResponse(result);
        break;
      }

      case 'CLASSIFY_RESPONSE': {
        let classification = null;
        if (msg.useOllama) {
          classification = await ollamaClient.classifyResponse(msg.prompt, msg.response);
        }
        // Fall back to rule-based if Ollama failed or offline
        if (!classification) {
          classification = classifyResponse(msg.prompt, msg.response);
        }
        sendResponse(classification);
        break;
      }

      case 'GENERATE_PROMPTS': {
        const suite = msg.suite;
        if (!suite) { sendResponse([]); break; }
        const prompts = await ollamaClient.generateTestPrompts(suite, 5);
        sendResponse(Array.isArray(prompts) ? prompts : []);
        break;
      }

      case 'PROGRESS_UPDATE':
        // Persist so a freshly-opened popup can restore the running state
        chrome.storage.local.set({ testerState: {
          running: true, text: msg.text, current: msg.current, total: msg.total
        }});
        relayToPopup(msg);
        sendResponse({ ok: true });
        break;

      case 'TEST_ERROR':
        chrome.storage.local.set({ testerState: { running: false, error: msg.error }});
        relayToPopup(msg);
        sendResponse({ ok: true });
        break;

      case 'SESSION_COMPLETE': {
        const { results, meta } = msg;
        const { jsonReport, htmlReport } = generateReport(results, meta);

        // Persist both state and report so popup can restore everything after reopen
        await chrome.storage.local.set({
          testerState: { running: false },
          lastReport: { jsonReport, htmlReport, timestamp: Date.now() }
        });

        relayToPopup({ type: 'SESSION_COMPLETE', jsonReport, htmlReport });
        sendResponse({ ok: true });
        break;
      }

      case 'UPDATE_OLLAMA_CONFIG':
        ollamaClient = new OllamaClient(msg.baseUrl || 'http://localhost:11434', msg.model || 'llama3');
        sendResponse({ ok: true });
        break;

      case 'STOP_TEST':
        // Forward stop signal to active content script
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'STOP_TEST' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();
  return true; // Keep channel open for async response
});
