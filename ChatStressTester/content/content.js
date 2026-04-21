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

  function simulateUserTurnViaWorker(useOllama, persona, scenario, history) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'SIMULATE_USER_TURN', useOllama, persona, scenario, history },
          r => resolve(r?.turn || null)
        );
      } catch { resolve(null); }
    });
  }

  // Generate a full fake persona once per conversation using Ollama.
  function generatePersonaViaWorker(useOllama, userFacts, expectedOutcome) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GENERATE_PERSONA', useOllama, userFacts, expectedOutcome },
          r => resolve(r?.persona || null)
        );
      } catch { resolve(null); }
    });
  }

  // Rule-based fallback persona built from path facts — used when Ollama is offline.
  function buildFallbackPersona(userFacts) {
    const facts = (userFacts || []).join(' ').toLowerCase();
    const exploring  = /exploring|not sure/.test(facts);
    const small      = /8 people/.test(facts);
    const large      = /250 employees/.test(facts);
    const noBudget   = /no budget|don't have a budget/.test(facts);
    const noTimeline = /next year|no firm/.test(facts);
    const noAuth     = /not sure who/.test(facts);
    const isBMIC     = /bmic partner/.test(facts);
    return {
      name:      exploring ? 'Jamie Torres'   : small ? 'Riley Chen' : large ? 'Morgan Blake' : 'Alex Johnson',
      company:   exploring ? 'Prospect LLC'   : small ? 'Nimble Works' : large ? 'Enterprise Group' : 'Growth Solutions Inc',
      role:      large     ? 'VP of Operations' : 'Operations Director',
      challenge: exploring
        ? "We're in early research mode — not totally sure what we need yet."
        : "Our lead qualification process is slow and inconsistent. We're losing deals because our team can't keep up.",
      teamSize:  small ? '8 employees' : large ? '250 employees' : '45 employees',
      budget:    noBudget ? 'none allocated yet' : isBMIC ? 'BMIC partner program' : '$75,000/year',
      timeline:  noTimeline ? 'next year, no firm date' : 'within 3 months',
      authority: noAuth ? 'need to identify stakeholders' : 'director-level, aligned with CEO'
    };
  }

  // Persona-aware fallback for when Ollama times out or is offline.
  function generateFallbackResponse(agentMessage, persona, turnIndex) {
    const p = persona || {};
    if (turnIndex === 0 || !agentMessage) {
      return `Hi, I'm ${p.name || 'a prospect'} from ${p.company || 'our company'}. ${(p.challenge || '').split('.')[0]}.`;
    }
    const lower = (agentMessage || '').toLowerCase();
    if (/challenge|problem|help|solve|what.*bring|what.*looking/.test(lower))
      return (p.challenge || '').split('.')[0] + '.';
    if (/employee|team|size|how many/.test(lower))
      return `We have ${p.teamSize || 'a mid-size team'}.`;
    if (/budget/.test(lower))
      return p.budget === 'none allocated yet'
        ? "We don't have a specific budget set yet."
        : `Our budget is around ${p.budget}.`;
    if (/timeline|when|implement|soon|urgency/.test(lower))
      return `We're looking at ${p.timeline || 'the near future'}.`;
    if (/decision|sign|approval|who.*involved|stakeholder/.test(lower))
      return `${p.authority || 'I handle this decision'}.`;
    if (/bmic/.test(lower))
      return (p.budget || '').toLowerCase().includes('bmic') ? "Yes, we're a BMIC partner." : "No, we're not a BMIC partner.";
    return `Sure — ${(p.challenge || 'we have some challenges').split('.')[0].toLowerCase()}.`;
  }

  // Ask Ollama to produce one turn using the pre-generated persona.
  function humanizeAnswerViaWorker(useOllama, agentMessage, persona, history) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'HUMANIZE_ANSWER', useOllama, agentMessage, persona, history },
          r => resolve(r?.answer || null)
        );
      } catch { resolve(null); }
    });
  }

  function classifyConversationViaWorker(useOllama, persona, scenario, history) {
    return new Promise(resolve => {
      const fallback = setTimeout(() => resolve({
        verdict: 'PASS', reason: 'Classifier timed out.', risk_level: 'low',
        was_helpful: true, handled_escalation: false, gave_wrong_info: false, quality_score: 5
      }), 25000);
      try {
        chrome.runtime.sendMessage(
          { type: 'CLASSIFY_CONVERSATION', useOllama, persona, scenario, history },
          r => { clearTimeout(fallback); resolve(r || { verdict: 'PASS', reason: 'No response.', risk_level: 'low', was_helpful: true, handled_escalation: false, gave_wrong_info: false, quality_score: 5 }); }
        );
      } catch { clearTimeout(fallback); resolve({ verdict: 'PASS', reason: 'Extension context lost.', risk_level: 'low', was_helpful: true, handled_escalation: false, gave_wrong_info: false, quality_score: 5 }); }
    });
  }

  // ---------------------------------------------------------------------------
  // Conversation session runner
  // ---------------------------------------------------------------------------

  async function runConversationSessions(convConfig, chatInterface, useOllamaClassifier, progressOffset, grandTotal, isStopped) {
    const { personas, scenario, turnsPerConv, numConversations, useOllama } = convConfig;
    const conversationResults = [];
    let step = 0;

    for (const persona of personas) {
      for (let convIdx = 0; convIdx < (numConversations || 1); convIdx++) {
        if (isStopped()) break;

        const convNum = conversationResults.length + 1;
        sendProgress(
          `Conversation ${convNum}: ${persona.name} as "${scenario.name}"…`,
          progressOffset + step, grandTotal
        );

        const history = [];
        const convStart = Date.now();

        for (let turn = 0; turn < (turnsPerConv || 4); turn++) {
          if (isStopped()) break;

          // Generate user message via Ollama, fall back to scripted line
          let userMsg = await simulateUserTurnViaWorker(useOllama, persona, scenario, history);
          if (!userMsg) {
            userMsg = persona.fallbacks[turn % persona.fallbacks.length];
          }

          sendProgress(
            `Conv ${convNum} [${persona.name}] turn ${turn + 1}/${turnsPerConv}: "${userMsg.slice(0, 40)}…"`,
            progressOffset + step, grandTotal
          );

          const tStart = Date.now();
          let agentResponse = '';
          try {
            const snapshot = window.__chatAdapter.getAgentMessageSnapshot(chatInterface);
            await window.__chatAdapter.sendMessage(chatInterface, userMsg);
            agentResponse = await window.__chatAdapter.waitForNewAgentMessage(chatInterface, snapshot);
          } catch (err) {
            agentResponse = '[Error: ' + String(err) + ']';
          }

          history.push({ role: 'user', content: userMsg, timestamp: new Date().toISOString() });
          history.push({ role: 'agent', content: agentResponse, timestamp: new Date().toISOString(), latencyMs: Date.now() - tStart });

          step++;

          if (turn < turnsPerConv - 1 && !isStopped()) {
            await delay(convConfig.delayBetweenMs || 1500);
          }
        }

        const classification = await classifyConversationViaWorker(useOllamaClassifier, persona, scenario, history);

        conversationResults.push({
          persona: persona.name,
          scenario: scenario.name,
          turns: history,
          classification,
          durationMs: Date.now() - convStart,
          platform: chatInterface.platform
        });
      }
      if (isStopped()) break;
    }

    return conversationResults;
  }

  // ---------------------------------------------------------------------------
  // Decision tree alignment runner
  // ---------------------------------------------------------------------------

  async function runDecisionTreeSessions(dtConfig, chatInterface, progressOffset, grandTotal, isStopped) {
    const { mermaidText, scenarios, turnsPerScenario, useOllama, delayBetweenMs: delay_ } = dtConfig;
    const dtResults = [];
    let step = 0;

    for (let si = 0; si < scenarios.length; si++) {
      if (isStopped()) break;
      const scenario = scenarios[si];

      sendProgress(
        `Decision tree ${si + 1}/${scenarios.length}: "${scenario.name}"…`,
        progressOffset + step, grandTotal
      );

      const history = [];
      const convStart = Date.now();
      const userFacts = scenario.userFacts || (scenario.userProfile ? [scenario.userProfile] : []);

      // Generate a rich persona once before the conversation begins
      sendProgress(`DT ${si + 1}/${scenarios.length}: generating persona…`, progressOffset + step, grandTotal);
      const persona = (await generatePersonaViaWorker(useOllama, userFacts, scenario.expectedOutcome || scenario.name))
                    || buildFallbackPersona(userFacts);

      for (let turn = 0; turn < (turnsPerScenario || 6); turn++) {
        if (isStopped()) break;

        const lastAgentMsg = history.filter(h => h.role === 'agent').pop()?.content || '';
        let userMsg = await humanizeAnswerViaWorker(useOllama, lastAgentMsg, persona, history);
        if (!userMsg) userMsg = generateFallbackResponse(lastAgentMsg, persona, turn);

        sendProgress(
          `DT ${si + 1}/${scenarios.length} turn ${turn + 1}/${turnsPerScenario}: "${userMsg.slice(0, 40)}…"`,
          progressOffset + step, grandTotal
        );

        const tStart = Date.now();
        let agentResponse = '';
        try {
          const snapshot = window.__chatAdapter.getAgentMessageSnapshot(chatInterface);
          await window.__chatAdapter.sendMessage(chatInterface, userMsg);
          agentResponse = await window.__chatAdapter.waitForNewAgentMessage(chatInterface, snapshot);
        } catch (err) {
          agentResponse = '[Error: ' + String(err) + ']';
        }

        history.push({ role: 'user', content: userMsg, timestamp: new Date().toISOString() });
        history.push({ role: 'agent', content: agentResponse, timestamp: new Date().toISOString(), latencyMs: Date.now() - tStart });
        step++;

        if (turn < turnsPerScenario - 1 && !isStopped()) await delay(delay_ || 1500);
      }

      // Ask Ollama whether the agent reached the expected outcome
      const alignment = await new Promise(resolve => {
        const fallback = setTimeout(() => resolve({
          aligned: false, verdict: 'WARN', reason: 'Alignment check timed out.', reached_outcome: 'Unknown'
        }), 30000);
        try {
          chrome.runtime.sendMessage(
            { type: 'CLASSIFY_DECISION_TREE', useOllama, mermaidText, scenario, history },
            r => { clearTimeout(fallback); resolve(r || { aligned: false, verdict: 'WARN', reason: 'No response.', reached_outcome: 'Unknown' }); }
          );
        } catch { clearTimeout(fallback); resolve({ aligned: false, verdict: 'WARN', reason: 'Context lost.', reached_outcome: 'Unknown' }); }
      });

      const dtResult = {
        scenario: scenario.name,
        userProfile: scenario.userProfile,
        expectedOutcome: scenario.expectedOutcome,
        turns: history,
        alignment,
        durationMs: Date.now() - convStart,
        platform: chatInterface.platform
      };
      dtResults.push(dtResult);

      _safeSend({ type: 'RESULT_ITEM',
        result: { suite: 'Decision Tree', prompt: `[${scenario.name}] Expected: ${scenario.expectedOutcome}`,
          response: alignment.reached_outcome || '?',
          classification: { verdict: alignment.verdict, reason: alignment.reason, risk_level: alignment.aligned ? 'low' : 'medium' },
          latencyMs: Date.now() - convStart },
        fullResult: dtResult,
        resultType: 'dt'
      });
    }

    return dtResults;
  }

  // ---------------------------------------------------------------------------
  // Full tree exhaustive runner — walks every leaf path with guided simulation
  // ---------------------------------------------------------------------------

  async function runFullTreeTest(fullTreeConfig, chatInterface, progressOffset, grandTotal, isStopped) {
    const { testCases, mermaidText, turnsPerPath, useOllama, delayBetweenMs: delay_ } = fullTreeConfig;
    const results = [];
    let step = 0;

    for (let ci = 0; ci < testCases.length; ci++) {
      if (isStopped()) break;
      const tc = testCases[ci];
      const userFacts = tc.userFacts || [];

      sendProgress(
        `Full tree ${ci + 1}/${testCases.length}: "${(tc.expectedOutcome || '').replace('Outcome: ', '').slice(0, 45)}"…`,
        progressOffset + step, grandTotal
      );

      const history = [];
      const convStart = Date.now();
      const maxTurns = turnsPerPath || 8;

      // Generate a rich persona once before this conversation starts
      sendProgress(
        `Full tree ${ci + 1}/${testCases.length}: generating persona…`,
        progressOffset + step, grandTotal
      );
      const persona = (await generatePersonaViaWorker(useOllama, userFacts, tc.expectedOutcome))
                    || buildFallbackPersona(userFacts);

      for (let turn = 0; turn < maxTurns; turn++) {
        if (isStopped()) break;

        const lastAgentMsg = history.filter(h => h.role === 'agent').pop()?.content || '';
        let userMsg = await humanizeAnswerViaWorker(useOllama, lastAgentMsg, persona, history);
        if (!userMsg) userMsg = generateFallbackResponse(lastAgentMsg, persona, turn);

        sendProgress(
          `Full tree ${ci + 1}/${testCases.length} turn ${turn + 1}/${maxTurns}: "${userMsg.slice(0, 40)}…"`,
          progressOffset + step, grandTotal
        );

        const tStart = Date.now();
        let agentResp = '';
        try {
          const snapshot = window.__chatAdapter.getAgentMessageSnapshot(chatInterface);
          await window.__chatAdapter.sendMessage(chatInterface, userMsg);
          agentResp = await window.__chatAdapter.waitForNewAgentMessage(chatInterface, snapshot);
        } catch (err) {
          agentResp = '[Error: ' + String(err) + ']';
        }

        history.push({ role: 'user', content: userMsg, timestamp: new Date().toISOString() });
        history.push({ role: 'agent', content: agentResp, timestamp: new Date().toISOString(), latencyMs: Date.now() - tStart });
        step++;

        if (turn < maxTurns - 1 && !isStopped()) await delay(delay_ || 1500);
      }

      // Classify whether the agent reached the expected leaf
      const alignment = await new Promise(resolve => {
        const fallback = setTimeout(() => resolve({ aligned: false, verdict: 'WARN', reason: 'Alignment check timed out.', reached_outcome: 'Unknown' }), 30000);
        try {
          chrome.runtime.sendMessage(
            { type: 'CLASSIFY_DECISION_TREE', useOllama, mermaidText,
              scenario: { name: `Path to: ${tc.expectedOutcome}`, userProfile: userFacts.join('; '), expectedOutcome: tc.expectedOutcome },
              history },
            r => { clearTimeout(fallback); resolve(r || { aligned: false, verdict: 'WARN', reason: 'No response.', reached_outcome: 'Unknown' }); }
          );
        } catch { clearTimeout(fallback); resolve({ aligned: false, verdict: 'WARN', reason: 'Context lost.', reached_outcome: 'Unknown' }); }
      });

      results.push({
        scenario: `Path to: ${tc.expectedOutcome}`,
        userProfile: userFacts.join('; '),
        expectedOutcome: tc.expectedOutcome,
        turns: history,
        alignment,
        durationMs: Date.now() - convStart,
        platform: chatInterface.platform
      });

      const ftResult = results[results.length - 1];
      _safeSend({ type: 'RESULT_ITEM',
        result: { suite: 'Full Tree', prompt: (tc.expectedOutcome || '').replace('Outcome: ', ''),
          response: alignment.reached_outcome || '?',
          classification: { verdict: alignment.verdict, reason: alignment.reason, risk_level: alignment.aligned ? 'low' : 'medium' },
          latencyMs: Date.now() - convStart },
        fullResult: ftResult,
        resultType: 'dt'
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Main runner
  // ---------------------------------------------------------------------------

  async function runTestSession(config) {
    const { suites, useOllamaGeneration, useOllamaClassifier, delayBetweenMs = 1500, conversationSim, decisionTree, fullTree } = config;

    const chatInterface = window.__chatAdapter.detectChat();
    if (!chatInterface) {
      _safeSend({ type: 'TEST_ERROR', error: 'No chat widget detected on this page. Try opening the chat first.' });
      window.__chatStressTesterRunning = false;
      return;
    }
    sendProgress(`Chat detected: ${chatInterface.platform}`, 0, 0);
    // Give the popup the meta info it needs for partial reports
    _safeSend({ type: 'META_UPDATE', meta: {
      url: window.location.href,
      date: new Date().toLocaleString(),
      platform: chatInterface.platform,
      totalDuration: null
    }});

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
    const convEnabled = !!(conversationSim?.enabled && conversationSim?.personas?.length > 0 && conversationSim?.scenario);
    const convTurns = convEnabled
      ? conversationSim.personas.length * (conversationSim.numConversations || 1) * (conversationSim.turnsPerConv || 4)
      : 0;
    const dtEnabled = !!(decisionTree?.enabled && decisionTree?.scenarios?.length > 0);
    const dtTurns = dtEnabled ? decisionTree.scenarios.length * (decisionTree.turnsPerScenario || 6) : 0;
    const ftEnabled = !!(fullTree?.enabled && fullTree?.testCases?.length > 0);
    const ftTurns = ftEnabled ? fullTree.testCases.length * (fullTree.turnsPerPath || 8) : 0;
    const grandTotal = total + convTurns + dtTurns + ftTurns;
    sendProgress(`Starting ${total} prompts${convEnabled ? ` + ${convTurns} conv turns` : ''}${dtEnabled ? ` + ${dtTurns} DT turns` : ''}${ftEnabled ? ` + ${ftTurns} full tree turns (${fullTree.testCases.length} paths)` : ''}…`, 0, grandTotal);

    const results = [];
    const sessionStart = Date.now();
    let stopped = false;

    const stopListener = msg => { if (msg.type === 'STOP_TEST') stopped = true; };
    try { chrome.runtime.onMessage.addListener(stopListener); } catch { /* context gone */ }

    for (let i = 0; i < allPrompts.length; i++) {
      if (stopped) { sendProgress('Test stopped by user.', i, total); break; }
      if (window.__chatStressTesterRunning === false) break; // extension reloaded

      const { suite, prompt } = allPrompts[i];
      sendProgress(`Sending prompt ${i + 1} of ${total} [${suite}]`, i + 1, grandTotal);

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

      const fullResult = { suite, prompt, response, classification: verdict,
        timestamp: new Date().toISOString(), latencyMs, platform: chatInterface.platform };
      results.push(fullResult);

      // Broadcast each result for the live feed and partial report accumulation.
      _safeSend({ type: 'RESULT_ITEM',
        result: { suite, prompt, response, classification: verdict, latencyMs },
        fullResult,
        resultType: 'prompt'
      });

      // Small pause between prompts to avoid hammering the UI
      if (i < allPrompts.length - 1 && !stopped) await delay(delayBetweenMs);
    }

    try { chrome.runtime.onMessage.removeListener(stopListener); } catch { /* context gone */ }

    // Run conversation simulation after prompt suites
    let conversationResults = [];
    if (!stopped && convEnabled) {
      sendProgress('Starting AI conversation simulation…', total, grandTotal);
      conversationResults = await runConversationSessions(
        { ...conversationSim, delayBetweenMs },
        chatInterface,
        useOllamaClassifier,
        total,
        grandTotal,
        () => stopped
      );
    }

    // Run decision tree alignment sessions
    let dtResults = [];
    if (!stopped && dtEnabled) {
      sendProgress('Starting decision tree alignment tests…', total + convTurns, grandTotal);
      dtResults = await runDecisionTreeSessions(
        { ...decisionTree, delayBetweenMs },
        chatInterface,
        total + convTurns,
        grandTotal,
        () => stopped
      );
    }

    // Run full tree exhaustive test
    if (!stopped && ftEnabled) {
      sendProgress(`Starting full tree test — ${fullTree.testCases.length} paths…`, total + convTurns + dtTurns, grandTotal);
      const ftResults = await runFullTreeTest(
        { ...fullTree, delayBetweenMs },
        chatInterface,
        total + convTurns + dtTurns,
        grandTotal,
        () => stopped
      );
      dtResults = dtResults.concat(ftResults);
    }

    const meta = {
      url: window.location.href,
      date: new Date().toLocaleString(),
      platform: chatInterface.platform,
      totalDuration: Date.now() - sessionStart
    };

    sendProgress('Generating report…', grandTotal, grandTotal);
    _safeSend({ type: 'SESSION_COMPLETE', results, conversationResults, dtResults, meta }, () => {
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
