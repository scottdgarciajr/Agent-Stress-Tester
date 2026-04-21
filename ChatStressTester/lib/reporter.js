// lib/reporter.js
// Generates JSON and self-contained HTML reports from stress test results.

function generateReport(results, meta, conversationResults = [], dtResults = []) {
  const summary = _buildSummary(results, conversationResults, dtResults);
  const jsonReport = { meta, summary, results, conversationResults, dtResults };
  const htmlReport = _buildHtml(results, meta, summary, conversationResults, dtResults);
  return { jsonReport, htmlReport };
}

function _buildSummary(results, conversationResults = [], dtResults = []) {
  const total = results.length;
  const passed = results.filter(r => r.classification?.verdict === 'PASS').length;
  const warned = results.filter(r => r.classification?.verdict === 'WARN').length;
  const failed = results.filter(r => r.classification?.verdict === 'FAIL').length;
  const timedOut = results.filter(r => r.classification?.verdict === 'TIMEOUT').length;
  const aborted = results.filter(r => r.classification?.verdict === 'ABORTED').length;
  const critical = results.filter(r => r.classification?.risk_level === 'critical').length;

  const bySuite = {};
  for (const r of results) {
    const s = r.suite || 'Unknown';
    if (!bySuite[s]) bySuite[s] = { pass: 0, warn: 0, fail: 0, timeout: 0 };
    const v = r.classification?.verdict || 'PASS';
    if (v === 'PASS') bySuite[s].pass++;
    else if (v === 'WARN') bySuite[s].warn++;
    else if (v === 'FAIL') bySuite[s].fail++;
    else bySuite[s].timeout++;
  }

  const conversations = conversationResults.length;
  const convPassed  = conversationResults.filter(r => r.classification?.verdict === 'PASS').length;
  const convWarned  = conversationResults.filter(r => r.classification?.verdict === 'WARN').length;
  const convFailed  = conversationResults.filter(r => r.classification?.verdict === 'FAIL').length;

  const dtTotal   = dtResults.length;
  const dtPassed  = dtResults.filter(r => r.alignment?.verdict === 'PASS').length;
  const dtFailed  = dtResults.filter(r => r.alignment?.verdict === 'FAIL').length;
  const dtWarned  = dtResults.filter(r => r.alignment?.verdict === 'WARN').length;
  const dtAligned = dtResults.filter(r => r.alignment?.aligned === true).length;

  return { total, passed, warned, failed, timedOut, aborted, critical, bySuite, conversations, convPassed, convWarned, convFailed, dtTotal, dtPassed, dtFailed, dtWarned, dtAligned };
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _trunc(str, len) {
  const s = String(str || '');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

function _verdictColor(v) {
  if (v === 'PASS') return '#1a7f3c';
  if (v === 'WARN') return '#b45309';
  if (v === 'FAIL' || v === 'TIMEOUT') return '#b91c1c';
  return '#6b7280';
}

function _verdictBg(v) {
  if (v === 'PASS') return '#f0fdf4';
  if (v === 'WARN') return '#fffbeb';
  if (v === 'FAIL' || v === 'TIMEOUT') return '#fef2f2';
  return '#f9fafb';
}

function _buildSvgChart(bySuite) {
  const suites = Object.keys(bySuite);
  if (!suites.length) return '';
  const barH = 28, gap = 10, labelW = 180, maxBarW = 300, paddingTop = 30;
  const maxVal = Math.max(1, ...suites.map(s => bySuite[s].pass + bySuite[s].warn + bySuite[s].fail + bySuite[s].timeout));
  const totalH = suites.length * (barH + gap) + paddingTop + 20;
  const totalW = labelW + maxBarW + 60;

  let bars = '';
  suites.forEach((suite, i) => {
    const y = paddingTop + i * (barH + gap);
    const d = bySuite[suite];
    const total = d.pass + d.warn + d.fail + d.timeout;
    const scale = maxBarW / maxVal;
    let x = labelW;
    const segments = [
      { val: d.pass, color: '#22c55e' },
      { val: d.warn, color: '#f59e0b' },
      { val: d.fail + d.timeout, color: '#ef4444' }
    ];
    for (const seg of segments) {
      const w = seg.val * scale;
      if (w > 0) {
        bars += `<rect x="${x}" y="${y}" width="${w}" height="${barH}" fill="${seg.color}" rx="3"/>`;
        x += w;
      }
    }
    bars += `<text x="${labelW - 8}" y="${y + barH / 2 + 5}" text-anchor="end" font-size="12" fill="#374151">${_esc(_trunc(suite, 22))}</text>`;
    bars += `<text x="${x + 6}" y="${y + barH / 2 + 5}" font-size="12" fill="#374151">${total}</text>`;
  });

  return `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
    <text x="${labelW}" y="16" font-size="13" fill="#6b7280">
      <tspan fill="#22c55e">■ Pass</tspan>  <tspan fill="#f59e0b">■ Warn</tspan>  <tspan fill="#ef4444">■ Fail</tspan>
    </text>
    ${bars}
  </svg>`;
}

function _buildConversationsHtml(conversationResults) {
  if (!conversationResults || conversationResults.length === 0) return '';

  const cards = conversationResults.map((conv, idx) => {
    const v = conv.classification?.verdict || '?';
    const score = conv.classification?.quality_score;
    const turns = (conv.turns || []).map(t => {
      const isUser  = t.role === 'user';
      const bg      = isUser ? '#f0f9ff' : '#f9fafb';
      const border  = isUser ? '#93c5fd' : '#d1d5db';
      const label   = isUser ? '👤 User' : '🤖 Agent';
      const latency = t.latencyMs ? ` <span style="color:#9ca3af;font-size:11px">(${t.latencyMs}ms)</span>` : '';
      return `<div style="margin-bottom:8px;padding:10px 12px;background:${bg};border-left:3px solid ${border};border-radius:4px">
        <div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:4px">${label}${latency}</div>
        <div style="white-space:pre-wrap;font-size:13px">${_esc(t.content)}</div>
      </div>`;
    }).join('');

    const headerColor = v === 'PASS' ? '#16a34a' : v === 'WARN' ? '#d97706' : '#dc2626';
    const headerBg    = v === 'PASS' ? '#f0fdf4' : v === 'WARN' ? '#fffbeb' : '#fef2f2';

    return `<div style="border:1px solid #e5e7eb;border-radius:10px;margin-bottom:20px;overflow:hidden">
      <div style="background:${headerBg};padding:12px 16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-weight:700;font-size:14px">Conversation ${idx + 1}</span>
          <span style="color:#6b7280;font-size:13px;margin-left:10px">👤 ${_esc(conv.persona)}</span>
          <span style="color:#6b7280;font-size:13px;margin-left:8px">📋 ${_esc(conv.scenario)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          ${score != null ? `<span style="font-size:12px;color:#6b7280">Quality: <strong>${score}/10</strong></span>` : ''}
          <span style="font-weight:700;color:${headerColor}">${_esc(v)}</span>
        </div>
      </div>
      <div style="padding:14px 16px">
        ${turns}
        <div style="margin-top:10px;padding:8px 12px;background:#f3f4f6;border-radius:6px;font-size:12px;color:#374151">
          <strong>Assessment:</strong> ${_esc(conv.classification?.reason || 'N/A')}
          ${conv.classification?.was_helpful === false ? ' &nbsp;|&nbsp; ⚠ Not helpful' : ''}
          ${conv.classification?.gave_wrong_info ? ' &nbsp;|&nbsp; ❌ Wrong info' : ''}
          ${conv.durationMs ? ` &nbsp;|&nbsp; ⏱ ${(conv.durationMs / 1000).toFixed(1)}s` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  return `<h2>AI Conversation Transcripts</h2>${cards}`;
}

function _buildDecisionTreeHtml(dtResults) {
  if (!dtResults || dtResults.length === 0) return '';

  const cards = dtResults.map((dt, idx) => {
    const v = dt.alignment?.verdict || '?';
    const aligned = dt.alignment?.aligned;
    const headerColor = v === 'PASS' ? '#16a34a' : v === 'WARN' ? '#d97706' : '#dc2626';
    const headerBg    = v === 'PASS' ? '#f0fdf4' : v === 'WARN' ? '#fffbeb' : '#fef2f2';

    const turns = (dt.turns || []).map(t => {
      const isUser = t.role === 'user';
      const bg     = isUser ? '#f0f9ff' : '#f9fafb';
      const border = isUser ? '#93c5fd' : '#d1d5db';
      const label  = isUser ? '👤 Simulated User' : '🤖 Agent';
      const latency = t.latencyMs ? ` <span style="color:#9ca3af;font-size:11px">(${t.latencyMs}ms)</span>` : '';
      return `<div style="margin-bottom:8px;padding:10px 12px;background:${bg};border-left:3px solid ${border};border-radius:4px">
        <div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:4px">${label}${latency}</div>
        <div style="white-space:pre-wrap;font-size:13px">${_esc(t.content)}</div>
      </div>`;
    }).join('');

    return `<div style="border:1px solid #e5e7eb;border-radius:10px;margin-bottom:20px;overflow:hidden">
      <div style="background:${headerBg};padding:12px 16px;border-bottom:1px solid #e5e7eb">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-weight:700;font-size:14px">Scenario ${idx + 1}: ${_esc(dt.scenario)}</span>
          </div>
          <span style="font-weight:700;color:${headerColor}">${_esc(v)}</span>
        </div>
        <div style="margin-top:6px;font-size:12px;color:#6b7280">
          👤 Profile: ${_esc(dt.userProfile)}<br>
          🎯 Expected: <strong>${_esc(dt.expectedOutcome)}</strong> &nbsp;|&nbsp;
          📍 Reached: <strong>${_esc(dt.alignment?.reached_outcome || '?')}</strong> &nbsp;|&nbsp;
          ${aligned ? '✅ Aligned' : '❌ Misaligned'}
        </div>
      </div>
      <div style="padding:14px 16px">
        ${turns}
        <div style="margin-top:10px;padding:8px 12px;background:#f3f4f6;border-radius:6px;font-size:12px;color:#374151">
          <strong>Assessment:</strong> ${_esc(dt.alignment?.reason || 'N/A')}
          ${dt.durationMs ? ` &nbsp;|&nbsp; ⏱ ${(dt.durationMs / 1000).toFixed(1)}s` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const total   = dtResults.length;
  const aligned = dtResults.filter(r => r.alignment?.aligned).length;
  const pct     = total > 0 ? Math.round((aligned / total) * 100) : 0;

  return `<h2>Decision Tree Alignment Results</h2>
  <p style="margin-bottom:12px;color:#374151;font-size:14px">
    <strong>${aligned}/${total}</strong> scenarios aligned with expected outcomes (${pct}%)
  </p>${cards}`;
}

function _buildHtml(results, meta, summary, conversationResults = [], dtResults = []) {
  const criticalResults = results.filter(r => r.classification?.verdict === 'FAIL');

  const rows = results.map(r => {
    const v = r.classification?.verdict || '?';
    const flags = [];
    if (r.classification?.leaked_system_info) flags.push('⚠ Leak');
    if (r.classification?.complied_with_injection) flags.push('💉 Injected');
    if (r.classification?.showed_confusion) flags.push('😕 Confused');
    if (r.classification?.appropriate_refusal) flags.push('✋ Refused');

    return `<tr style="background:${_verdictBg(v)}">
      <td>${_esc(r.suite)}</td>
      <td title="${_esc(r.prompt)}">${_esc(_trunc(r.prompt, 80))}</td>
      <td title="${_esc(r.response)}">${_esc(_trunc(r.response, 120))}</td>
      <td style="color:${_verdictColor(v)};font-weight:700">${_esc(v)}</td>
      <td>${_esc(r.classification?.risk_level || '')}</td>
      <td>${flags.join(' ')}</td>
      <td>${r.latencyMs ? r.latencyMs + 'ms' : ''}</td>
    </tr>`;
  }).join('');

  const criticalHtml = criticalResults.length === 0
    ? '<p style="color:#6b7280">No critical failures found.</p>'
    : criticalResults.map(r => `
        <div style="border:2px solid #ef4444;border-radius:8px;padding:16px;margin-bottom:16px;background:#fff5f5">
          <div style="font-weight:700;color:#b91c1c;margin-bottom:8px">Suite: ${_esc(r.suite)}</div>
          <div style="margin-bottom:6px"><strong>Prompt:</strong><br><code style="white-space:pre-wrap;font-size:13px">${_esc(r.prompt)}</code></div>
          <div style="margin-bottom:6px"><strong>Response:</strong><br><code style="white-space:pre-wrap;font-size:13px">${_esc(r.response)}</code></div>
          <div style="color:#b91c1c"><strong>Reason:</strong> ${_esc(r.classification?.reason)}</div>
        </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatStressTester Report</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f9fafb;color:#111827}
  h1{font-size:28px;margin:0 0 4px}
  .meta{color:#6b7280;font-size:14px;margin-bottom:24px}
  .cards{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px}
  .card{background:#fff;border-radius:10px;padding:16px 24px;box-shadow:0 1px 4px rgba(0,0,0,.08);min-width:120px;text-align:center}
  .card .val{font-size:32px;font-weight:800}
  .card .lbl{font-size:13px;color:#6b7280;margin-top:4px}
  .pass{color:#16a34a}.warn{color:#d97706}.fail{color:#dc2626}.info{color:#2563eb}
  h2{font-size:20px;margin:32px 0 12px;border-bottom:2px solid #e5e7eb;padding-bottom:6px}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  th{background:#f3f4f6;padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  td{padding:9px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;max-width:300px;word-break:break-word}
  .chart-wrap{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:32px;overflow-x:auto}
  footer{margin-top:40px;text-align:center;color:#9ca3af;font-size:13px}
</style>
</head>
<body>
<h1>🧪 ChatStressTester Report</h1>
<div class="meta">
  <strong>URL:</strong> ${_esc(meta.url)} &nbsp;|&nbsp;
  <strong>Date:</strong> ${_esc(meta.date)} &nbsp;|&nbsp;
  <strong>Platform:</strong> ${_esc(meta.platform)} &nbsp;|&nbsp;
  <strong>Duration:</strong> ${meta.totalDuration ? (meta.totalDuration / 1000).toFixed(1) + 's' : 'N/A'}
</div>

<div class="cards">
  <div class="card"><div class="val info">${summary.total}</div><div class="lbl">Total Prompts</div></div>
  <div class="card"><div class="val pass">${summary.passed}</div><div class="lbl">Passed</div></div>
  <div class="card"><div class="val warn">${summary.warned}</div><div class="lbl">Warnings</div></div>
  <div class="card"><div class="val fail">${summary.failed}</div><div class="lbl">Failures</div></div>
  <div class="card"><div class="val fail">${summary.critical}</div><div class="lbl">Critical</div></div>
  ${summary.conversations > 0 ? `<div class="card"><div class="val info">${summary.conversations}</div><div class="lbl">Conversations</div></div>
  <div class="card"><div class="val pass">${summary.convPassed}</div><div class="lbl">Conv Passed</div></div>
  <div class="card"><div class="val fail">${summary.convFailed}</div><div class="lbl">Conv Issues</div></div>` : ''}
  ${summary.dtTotal > 0 ? `<div class="card"><div class="val info">${summary.dtTotal}</div><div class="lbl">DT Scenarios</div></div>
  <div class="card"><div class="val pass">${summary.dtAligned}</div><div class="lbl">DT Aligned</div></div>
  <div class="card"><div class="val fail">${summary.dtFailed}</div><div class="lbl">DT Misaligned</div></div>` : ''}
</div>

<h2>Results by Suite</h2>
<div class="chart-wrap">${_buildSvgChart(summary.bySuite)}</div>

<h2>All Results</h2>
<table>
  <thead><tr>
    <th>Suite</th><th>Prompt</th><th>Response</th><th>Verdict</th><th>Risk</th><th>Flags</th><th>Latency</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>

<h2>Critical Findings</h2>
${criticalHtml}

${_buildConversationsHtml(conversationResults)}

${_buildDecisionTreeHtml(dtResults)}

<footer>Generated by ChatStressTester &mdash; ${_esc(meta.date)}</footer>
</body>
</html>`;
}

if (typeof module !== 'undefined') module.exports = { generateReport };
