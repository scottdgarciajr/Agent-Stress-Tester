// content/adapter.js
// Detects chat widgets and provides sendMessage / waitForNewAgentMessage helpers.
// Key design: caller must snapshot existing agent nodes BEFORE sending a message,
// then pass that snapshot to waitForNewAgentMessage so the welcome message and
// prior responses are never mistaken for a fresh reply.

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _tryIframeAccess(iframe) {
  try { return iframe.contentDocument || iframe.contentWindow?.document || null; }
  catch { return null; }
}

function _findInputAndButton(root) {
  if (!root) return null;
  const input = root.querySelector('input[type="text"], input:not([type]), textarea');
  if (!input) return null;
  const btn =
    root.querySelector('button[type="submit"]') ||
    root.querySelector('button[data-testid*="send"], button[aria-label*="send" i]') ||
    root.querySelector('button');
  return btn ? { input, btn, isContentEditable: false } : null;
}

function _findProseMirrorComposer(root) {
  if (!root) return null;
  const pm =
    root.querySelector('[data-test-id="rte-content"][contenteditable="true"]') ||
    root.querySelector('.ProseMirror[contenteditable="true"]') ||
    root.querySelector('[contenteditable="true"]');
  if (!pm) return null;
  const btn =
    root.querySelector('button[data-button-use="primary"]') ||
    root.querySelector('button[data-fnd-button]') ||
    root.querySelector('button');
  if (!btn) return null;
  return { input: pm, btn, isContentEditable: true };
}

function _searchShadowRoots(root) {
  for (const el of root.querySelectorAll('*')) {
    if (!el.shadowRoot) continue;
    const found = _findInputAndButton(el.shadowRoot) || _findProseMirrorComposer(el.shadowRoot);
    if (found) {
      const container = el.shadowRoot.querySelector('[class*="message"], [class*="chat"], [class*="conversation"]') || el.shadowRoot;
      return { inputEl: found.input, sendBtn: found.btn, messageContainer: container, platform: 'shadow-dom', isContentEditable: found.isContentEditable };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HubSpot Agent Testing UI (app.hubspot.com — ProseMirror, no iframe)
// ---------------------------------------------------------------------------

function _detectHubSpotAgentTesting() {
  const hasSendKey = document.querySelector('i18n-string[data-key*="messageComposer.send"], i18n-string[data-key*="thread"]');
  const hasPM = document.querySelector('[class*="ProsemirrorEditor"], .ProseMirror[contenteditable="true"]');
  if (!hasSendKey && !hasPM) return null;
  const found = _findProseMirrorComposer(document);
  if (!found) return null;
  const messageContainer =
    document.querySelector('[data-thread-id]') ||
    document.querySelector('[class*="ScrollContainer"], [class*="ScrollingColumn"]') ||
    document.body;
  return { inputEl: found.input, sendBtn: found.btn, messageContainer, platform: 'hubspot-agent-testing', isContentEditable: true };
}

// ---------------------------------------------------------------------------
// Public: detectChat()
// ---------------------------------------------------------------------------

function detectChat() {
  const hsAgent = _detectHubSpotAgentTesting();
  if (hsAgent) return hsAgent;

  const hsIframe = document.querySelector('iframe#hubspot-messages-iframe');
  if (hsIframe) {
    const doc = _tryIframeAccess(hsIframe);
    const els = _findInputAndButton(doc) || _findProseMirrorComposer(doc);
    if (els) {
      const container = doc.querySelector('[class*="message"], [class*="conversation"]') || doc.body;
      return { inputEl: els.input, sendBtn: els.btn, messageContainer: container, platform: 'hubspot', isContentEditable: els.isContentEditable };
    }
  }

  for (const [pattern, platform] of [
    [f => f.src?.includes('intercom'), 'intercom'],
    [f => /drift/i.test(f.id), 'drift'],
    [f => /launcher|webWidget/i.test(f.id), 'zendesk'],
    [() => true, 'generic-iframe']
  ]) {
    const iframe = [...document.querySelectorAll('iframe')].find(pattern);
    if (!iframe) continue;
    const doc = _tryIframeAccess(iframe);
    if (!doc) continue;
    const els = _findInputAndButton(doc) || _findProseMirrorComposer(doc);
    if (els) {
      const container = doc.querySelector('[class*="message"], [class*="chat"], [class*="conversation"]') || doc.body;
      return { inputEl: els.input, sendBtn: els.btn, messageContainer: container, platform, isContentEditable: els.isContentEditable };
    }
  }

  const shadowResult = _searchShadowRoots(document);
  if (shadowResult) return shadowResult;

  const directEls = _findInputAndButton(document) || _findProseMirrorComposer(document);
  if (directEls) {
    const container = document.querySelector('[class*="message"], [class*="chat"], [class*="conversation"]') || document.body;
    const platform = directEls.isContentEditable ? 'direct-contenteditable' : 'direct';
    return { inputEl: directEls.input, sendBtn: directEls.btn, messageContainer: container, platform, isContentEditable: directEls.isContentEditable };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public: getAgentMessageSnapshot()
// Call this BEFORE sending a message to capture the baseline set of agent
// nodes. Pass the result to waitForNewAgentMessage so prior messages
// (welcome, earlier replies) are excluded from detection.
// ---------------------------------------------------------------------------

function getAgentMessageSnapshot(chatInterface) {
  const { messageContainer, platform } = chatInterface;
  return new Set([...messageContainer.querySelectorAll(_agentMessageSelector(platform))]);
}

// ---------------------------------------------------------------------------
// Public: sendMessage()
// ---------------------------------------------------------------------------

function _freshComposer(chatInterface) {
  // Re-query the ProseMirror node in case the DOM was refreshed between prompts.
  const pm =
    document.querySelector('[data-test-id="rte-content"][contenteditable="true"]') ||
    document.querySelector('.ProseMirror[contenteditable="true"]');
  if (pm) chatInterface.inputEl = pm;
  const btn = document.querySelector('button[data-button-use="primary"]') ||
              document.querySelector('button[data-fnd-button]');
  if (btn) chatInterface.sendBtn = btn;
}

function _insertTextIntoContentEditable(el, text) {
  // Guard: element must be in the live document or this crashes with "addRange not in document"
  if (!document.contains(el)) return false;
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    el.innerText = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

function _waitForButtonEnabled(btn, maxWaitMs = 4000) {
  return new Promise(resolve => {
    if (btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) { resolve(); return; }
    const start = Date.now();
    const iv = setInterval(() => {
      if (btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > maxWaitMs) { clearInterval(iv); resolve(); }
    }, 80);
  });
}

function sendMessage(chatInterface, text) {
  return new Promise(async (resolve) => {
    const { isContentEditable } = chatInterface;

    if (isContentEditable) {
      // Re-query in case DOM refreshed after the previous send
      _freshComposer(chatInterface);
      const ok = _insertTextIntoContentEditable(chatInterface.inputEl, text);
      if (!ok) { resolve(); return; }
    } else {
      const { inputEl } = chatInterface;
      inputEl.focus();
      const proto = inputEl instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(inputEl, text); else inputEl.value = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Wait for the send button to re-enable (HubSpot keeps it disabled until text is present)
    await new Promise(r => setTimeout(r, 350));
    await _waitForButtonEnabled(chatInterface.sendBtn, 4000);

    try { chatInterface.sendBtn.click(); }
    catch { chatInterface.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); }

    // Short pause so the send registers before the caller sets up the response observer
    await new Promise(r => setTimeout(r, 200));
    resolve();
  });
}

// ---------------------------------------------------------------------------
// Public: waitForNewAgentMessage(chatInterface, existingSnapshot)
// Waits indefinitely for an agent message that is NOT in existingSnapshot.
// Uses a 2-second stability window (no DOM changes = streaming complete).
// There is no hard timeout — the test loop relies on the stop button or
// the browser tab being closed to abort.
// ---------------------------------------------------------------------------

function waitForNewAgentMessage(chatInterface, existingSnapshot) {
  return new Promise((resolve) => {
    const { messageContainer, platform } = chatInterface;
    let stabilityTimer = null;
    let candidateNode = null;
    let resolved = false;

    function done(text) {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(stabilityTimer);
      resolve(text);
    }

    function extractText(node) {
      if (!node) return '';
      const pre = node.querySelector('pre, [class*="SafeHTML"], [class*="RichText"]');
      return ((pre || node).innerText || (pre || node).textContent || '').trim();
    }

    function check() {
      const current = [...messageContainer.querySelectorAll(_agentMessageSelector(platform))];
      const newNodes = current.filter(n => !existingSnapshot.has(n));
      if (newNodes.length === 0) return;
      candidateNode = newNodes[newNodes.length - 1];
      clearTimeout(stabilityTimer);
      // Wait 2 s of silence = streaming is complete
      stabilityTimer = setTimeout(() => done(extractText(candidateNode)), 2000);
    }

    const observer = new MutationObserver(check);
    observer.observe(messageContainer, { childList: true, subtree: true, characterData: true });

    // Also run check immediately in case response already arrived between snapshot and now
    check();
  });
}

// Returns a CSS selector that matches agent/bot message nodes for the given platform.
function _agentMessageSelector(platform) {
  switch (platform) {
    case 'hubspot-agent-testing':
    case 'hubspot':
      return '[class*="BasicMessageCardWrapper"]:not([class*="VisitorMessageCardWrapper"])';
    default:
      return '[class*="bot"], [class*="agent"], [class*="assistant"], [data-author="bot"], [class*="message--received"]';
  }
}

window.__chatAdapter = { detectChat, getAgentMessageSnapshot, sendMessage, waitForNewAgentMessage };
