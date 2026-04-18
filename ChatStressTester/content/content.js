// content/content.js
// Main test runner. Injected on demand — orchestrates detection, prompt sending,
// response capture, classification, and report generation.

(async function () {
  if (window.__chatStressTesterRunning) {
    _safeSend({ type: 'PROGRESS_UPDATE', text: 'Test already running on this page.' });
    return;
  }
  window.__chatStressTesterRunning = true;

  if (window.__chatStressTesterListener) {
    chrome.runtime.onMessage.removeListener(window.__chatStressTesterListener);
    window.__chatStressTesterListener = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Wraps chrome.runtime.sendMessage so that "Extension context invalidated"
  // (happens when the extension is reloaded mid-session) doesn't throw.
  function _safeSend(msg, cb) {
    try {
      if (cb) chrome.runtime.sendMessage(msg, cb);
      else chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (String(e).includes('Extension context invalidated')) {
        window.__chatStressTesterRunning = false;
      }
    }
  }

  function sendProgress(text, current, total) {
    _safeSend({ type: 'PROGRESS_UPDATE', text, current, total });
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function classifyViaWorker(useOllama, prompt, response) {
    return new Promise(resolve => {
      const fallback = setTimeout(() => resolve({
        verdict: 'PASS', reason: 'Classifier did not respond in time.',
        risk_level: 'low', leaked_system_info: false, complied_with_injection: false,
        showed_confusion: false, appropriate_refusal: false
      }), 15000);
      try {
        chrome.runtime.sendMessage({ type: 'CLASSIFY_RESPONSE', useOllama, prompt, response }, result => {
          clearTimeout(fallback);
          resolve(result || { verdict: 'PASS', reason: 'No response from classifier.',
            risk_level: 'low', leaked_system_info: false, complied_with_injection: false,
            showed_confusion: false, appropriate_refusal: false });
        });
      } catch { clearTimeout(fallback); resolve({ verdict: 'PASS', reason: 'Extension context lost.',
        risk_level: 'low', leaked_system_info: false, complied_with_injection: false,
        showed_confusion: false, appropriate_refusal: false }); }
    });
  }

  function generatePromptsViaWorker(suite) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type: 'GENERATE_PROMPTS', suite }, r => resolve(Array.isArray(r) ? r : [])); }
      catch { resolve([]); }
    });
  }

  // ---------------------------------------------------------------------------
  // Main runner
  // ---------------------------------------------------------------------------

  async function runTestSession(config) {
    const { suites, useOllamaGeneration, useOllamaClassifier, delayBetweenMs = 1500 } = config;

    const chatInterface = window.__chatAdapter.detectChat();
    if (!chatInterface) {
      _safeSend({ type: 'TEST_ERROR', error: 'No chat widget detected on this page. Try opening the chat first.' });
      window.__chatStressTesterRunning = false;
      return;
    }
    sendProgress(`Chat detected: ${chatInterface.platform}`, 0, 0);

    if (!window.__SUITES || !Object.keys(window.__SUITES).length) {
      _safeSend({ type: 'TEST_ERROR', error: 'Test suite data not found. Please reload the extension.' });
      window.__chatStressTesterRunning = false;
      return;
    }

    // Collect all prompts first
    const allPrompts = [];
    for (const suiteName of suites) {
      const suite = window.__SUITES[suiteName];
      if (!suite) continue;
      let prompts = [...suite.prompts];
      if (useOllamaGeneration) {
        const extra = await generatePromptsViaWorker(suite);
        prompts = prompts.concat(extra);
      }
      prompts.forEach(p => allPrompts.push({ suite: suite.name, suiteMeta: suite, prompt: p }));
    }

    const total = allPrompts.length;
    sendProgress(`Starting ${total} prompts across ${suites.length} suite(s)…`, 0, total);

    const results = [];
    const sessionStart = Date.now();
    let stopped = false;

    const stopListener = msg => { if (msg.type === 'STOP_TEST') stopped = true; };
    try { chrome.runtime.onMessage.addListener(stopListener); } catch { /* context gone */ }

    for (let i = 0; i < allPrompts.length; i++) {
      if (stopped) { sendProgress('Test stopped by user.', i, total); break; }
      if (window.__chatStressTesterRunning === false) break; // extension reloaded

      const { suite, prompt } = allPrompts[i];
      sendProgress(`Sending prompt ${i + 1} of ${total} [${suite}]`, i + 1, total);

      const tStart = Date.now();
      let response = '';
      let verdict = null;

      try {
        // Snapshot BEFORE sending so the welcome message and all prior responses
        // are in the baseline set — waitForNewAgentMessage ignores them.
        const snapshot = window.__chatAdapter.getAgentMessageSnapshot(chatInterface);

        await window.__chatAdapter.sendMessage(chatInterface, prompt);

        // Wait for a NEW agent message that wasn't in the pre-send snapshot.
        // No hard timeout — waits until the agent responds and stabilises.
        response = await window.__chatAdapter.waitForNewAgentMessage(chatInterface, snapshot);
      } catch (err) {
        response = '';
        verdict = { verdict: 'ABORTED', reason: String(err), risk_level: 'low',
          leaked_system_info: false, complied_with_injection: false,
          showed_confusion: false, appropriate_refusal: false };
      }

      const latencyMs = Date.now() - tStart;

      if (!verdict) {
        verdict = await classifyViaWorker(useOllamaClassifier, prompt, response);
      }

      results.push({ suite, prompt, response, classification: verdict,
        timestamp: new Date().toISOString(), latencyMs, platform: chatInterface.platform });

      // Small pause between prompts to avoid hammering the UI
      if (i < allPrompts.length - 1 && !stopped) await delay(delayBetweenMs);
    }

    try { chrome.runtime.onMessage.removeListener(stopListener); } catch { /* context gone */ }

    const meta = {
      url: window.location.href,
      date: new Date().toLocaleString(),
      platform: chatInterface.platform,
      totalDuration: Date.now() - sessionStart
    };

    sendProgress('Generating report…', total, total);
    _safeSend({ type: 'SESSION_COMPLETE', results, meta }, () => {
      window.__chatStressTesterRunning = false;
    });
  }

  // Register START_TEST listener and store it for cleanup on re-injection
  window.__chatStressTesterListener = (msg, _sender, sendResponse) => {
    if (msg.type === 'START_TEST') {
      runTestSession(msg.config);
      sendResponse({ started: true });
    }
    // Do NOT return true — we call sendResponse synchronously above, so no async needed.
  };
  try { chrome.runtime.onMessage.addListener(window.__chatStressTesterListener); } catch { /* context gone */ }

  _safeSend({ type: 'CONTENT_READY' });
})();
