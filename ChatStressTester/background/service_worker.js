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

// ---------------------------------------------------------------------------
// Mermaid parser — extracts nodes and edges without any external library.
// ---------------------------------------------------------------------------

function parseMermaid(text) {
  const SKIP = new Set(['flowchart', 'graph', 'subgraph', 'end', 'TD', 'LR', 'TB', 'BT', 'RL']);
  const nodes = {};

  // Rectangle nodes: ID[Label]
  const sqRe = /\b([A-Za-z][A-Za-z0-9_]*)\[([^\]]+)\]/g;
  let m;
  while ((m = sqRe.exec(text)) !== null) {
    if (!SKIP.has(m[1])) nodes[m[1]] = m[2].trim();
  }
  // Diamond nodes: ID{Label}
  const dmRe = /\b([A-Za-z][A-Za-z0-9_]*)\{([^}]+)\}/g;
  while ((m = dmRe.exec(text)) !== null) {
    if (!SKIP.has(m[1])) nodes[m[1]] = m[2].trim();
  }

  // Edges: A --> B  or  A -->|label| B
  const edges = [];
  const edgeRe = /\b([A-Za-z][A-Za-z0-9_]*)\s*-->\s*(?:\|([^|]*)\|\s*)?([A-Za-z][A-Za-z0-9_]*)\b/g;
  while ((m = edgeRe.exec(text)) !== null) {
    if (!SKIP.has(m[1]) && !SKIP.has(m[3])) {
      edges.push({ from: m[1], label: (m[2] || '').trim(), to: m[3] });
    }
  }

  return { nodes, edges };
}

// Convert one path step's context into a human-readable user profile fact.
function stepToFact(fromLabel, edgeLabel) {
  const q = (fromLabel || '').toLowerCase();
  const a = (edgeLabel || '').toLowerCase().trim();
  if (!a) return null;

  if (/need identified|clear need|challenge/.test(q)) {
    return a.includes('yes')
      ? 'You have a clear, specific business problem you want to solve'
      : "You're not quite sure what you need yet — still exploring";
  }
  if (/employee|team size|full-time/.test(q)) {
    if (a.includes('≤10') || a === '10') return 'Your team has about 8 people';
    if (a.includes('11-100'))            return 'Your team has about 45 employees';
    if (a.includes('100+'))              return 'Your team has about 250 employees';
    return `Team size: ${edgeLabel}`;
  }
  if (/bmic/.test(q)) {
    return a.includes('yes') ? 'You ARE a BMIC partner' : 'You are NOT a BMIC partner';
  }
  if (/budget/.test(q)) {
    return a.includes('yes')
      ? 'You have an approved budget of around $75k per year'
      : "You don't have a budget allocated yet";
  }
  if (/timeline|implement|soon/.test(q)) {
    return a.includes('yes')
      ? 'You want to implement within the next 3 months'
      : "No firm timeline yet — probably sometime next year";
  }
  if (/decision|involved/.test(q)) {
    return a.includes('yes')
      ? 'You and your CEO are the decision makers and both ready to move forward'
      : "You're not sure who else needs to sign off";
  }
  // Generic
  return `${fromLabel}: ${edgeLabel}`;
}

// Walk all root-to-leaf paths in the parsed tree and return them with user facts.
function allLeafPaths(parsedTree) {
  const { nodes, edges } = parsedTree;

  const adj = {};
  for (const id of Object.keys(nodes)) adj[id] = [];
  for (const e of edges) {
    if (!adj[e.from]) adj[e.from] = [];
    adj[e.from].push({ to: e.to, label: e.label });
    if (!adj[e.to]) adj[e.to] = [];
  }

  // Root: appears as 'from' but never as 'to'
  const toSet  = new Set(edges.map(e => e.to));
  const roots  = Object.keys(nodes).filter(id => !toSet.has(id));
  const root   = roots[0] || Object.keys(nodes)[0];
  const isLeaf = id => !adj[id] || adj[id].length === 0 || /outcome/i.test(nodes[id] || '');

  const paths = [];
  function dfs(id, steps, visited) {
    if (isLeaf(id)) {
      const userFacts = steps.map(s => stepToFact(s.fromLabel, s.edgeLabel)).filter(Boolean);
      paths.push({ leafLabel: nodes[id] || id, steps, userFacts });
      return;
    }
    if (visited.has(id)) return;
    const next = new Set([...visited, id]);
    for (const edge of (adj[id] || [])) {
      dfs(edge.to, [...steps, { fromId: id, fromLabel: nodes[id] || id, edgeLabel: edge.label }], next);
    }
  }
  dfs(root, [], new Set());
  return paths;
}

// Rule-based fallback: extract outcome nodes from Mermaid text and build minimal scenarios.
function scenariosFromMermaid(mermaidText) {
  const seen = new Set();
  const scenarios = [];
  // Match node definitions like: ID[some label] — capture label text
  const nodeRe = /[A-Za-z0-9_]+\[([^\]]+)\]/g;
  let m;
  while ((m = nodeRe.exec(mermaidText)) !== null) {
    const label = m[1].trim();
    // Only keep outcome / leaf nodes
    if (/outcome|qualified|route|book|nurture|self.serve|handling/i.test(label) && !seen.has(label)) {
      seen.add(label);
      const short = label.replace(/^Outcome:\s*/i, '').slice(0, 50);
      scenarios.push({
        name: short,
        userProfile: `User who should reach: ${short}`,
        expectedOutcome: label,
        systemInstructions:
          `You are a prospect in a sales qualification conversation. ` +
          `Answer questions naturally so that the agent routes you to: "${short}". Be realistic and specific.`
      });
    }
  }
  return scenarios;
}

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
        if (!classification) {
          classification = classifyResponse(msg.prompt, msg.response);
        }
        sendResponse(classification);
        break;
      }

      case 'SIMULATE_USER_TURN': {
        let turn = null;
        if (msg.useOllama) {
          turn = await ollamaClient.simulateUserTurn(msg.persona, msg.scenario, msg.history || []);
        }
        sendResponse({ turn });
        break;
      }

      case 'CLASSIFY_CONVERSATION': {
        let classification = null;
        if (msg.useOllama) {
          classification = await ollamaClient.classifyConversation(msg.persona, msg.scenario, msg.history || []);
        }
        if (!classification) {
          classification = classifyConversation(msg.persona, msg.scenario, msg.history || []);
        }
        sendResponse(classification);
        break;
      }

      case 'GENERATE_PERSONA': {
        let persona = null;
        if (msg.useOllama) {
          persona = await ollamaClient.generatePersona(msg.userFacts || [], msg.expectedOutcome || '');
        }
        sendResponse({ persona });
        break;
      }

      case 'EXTRACT_TREE_PATHS': {
        const tree  = parseMermaid(msg.mermaidText || '');
        const paths = allLeafPaths(tree);
        sendResponse(paths.map((p, i) => ({
          id: i,
          expectedOutcome: p.leafLabel,
          userFacts: p.userFacts,
          stepCount: p.steps.length
        })));
        break;
      }

      case 'HUMANIZE_ANSWER': {
        let answer = null;
        if (msg.useOllama) {
          answer = await ollamaClient.humanizeAnswer(msg.agentMessage, msg.persona, msg.history || []);
        }
        sendResponse({ answer });
        break;
      }

      case 'PARSE_DECISION_TREE': {
        let scenarios = await ollamaClient.parseDecisionTree(msg.mermaidText, msg.numScenarios || 4);
        // If Ollama couldn't produce valid JSON, fall back to rule-based extraction
        if (!scenarios.length) {
          scenarios = scenariosFromMermaid(msg.mermaidText);
        }
        sendResponse(scenarios);
        break;
      }

      case 'CLASSIFY_DECISION_TREE': {
        let dtResult = null;
        if (msg.useOllama) {
          dtResult = await ollamaClient.classifyDecisionTreeAlignment(msg.mermaidText, msg.scenario, msg.history || []);
        }
        if (!dtResult) {
          dtResult = { aligned: true, verdict: 'WARN', reason: 'Ollama unavailable — could not classify alignment.', reached_outcome: 'Unknown' };
        }
        sendResponse(dtResult);
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

      case 'GENERATE_PARTIAL_REPORT': {
        const { results: pr = [], conversationResults: cr = [], dtResults: dr = [], meta: pm } = msg;
        const safeMeta = pm || { url: '(in progress)', date: new Date().toLocaleString(), platform: '?', totalDuration: null };
        const { htmlReport } = generateReport(pr, safeMeta, cr, dr);
        sendResponse({ htmlReport });
        break;
      }

      case 'SESSION_COMPLETE': {
        const { results, meta, conversationResults = [], dtResults = [] } = msg;
        const { jsonReport, htmlReport } = generateReport(results, meta, conversationResults, dtResults);

        // Persist both state and report so popup can restore everything after reopen
        await chrome.storage.local.set({
          testerState: { running: false },
          lastReport: { jsonReport, htmlReport, timestamp: Date.now() }
        });

        relayToPopup({ type: 'SESSION_COMPLETE', jsonReport, htmlReport });
        sendResponse({ ok: true });
        break;
      }

      case 'META_UPDATE': {
        // Reset live storage at the start of every new test run
        await chrome.storage.local.set({
          liveData: { results: [], conversationResults: [], dtResults: [], meta: msg.meta }
        });
        relayToPopup(msg);
        sendResponse({ ok: true });
        break;
      }

      case 'RESULT_ITEM': {
        // Persist each result so the live report page can read it even if the popup freezes
        const stored = await chrome.storage.local.get('liveData');
        const ld = stored.liveData || { results: [], conversationResults: [], dtResults: [], meta: null };
        if (msg.fullResult) {
          if (msg.resultType === 'dt') ld.dtResults.push(msg.fullResult);
          else ld.results.push(msg.fullResult);
        }
        await chrome.storage.local.set({ liveData: ld });
        relayToPopup(msg);
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
