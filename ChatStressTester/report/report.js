// report/report.js — polls chrome.storage.local.liveData and renders the live report

const frame      = document.getElementById('reportFrame');
const emptyMsg   = document.getElementById('emptyMsg');
const statusText = document.getElementById('statusText');
const dot        = document.getElementById('dot');
const refreshBtn = document.getElementById('refreshBtn');

let lastResultCount = 0;

function refresh() {
  chrome.storage.local.get('liveData', ({ liveData }) => {
    if (!liveData) return;
    const results          = liveData.results          || [];
    const conversationResults = liveData.conversationResults || [];
    const dtResults        = liveData.dtResults        || [];
    const meta             = liveData.meta;

    if (!results.length && !dtResults.length) return;

    const safeMeta = meta || {
      url: '(in progress)',
      date: new Date().toLocaleString(),
      platform: '?',
      totalDuration: null
    };

    const { htmlReport } = generateReport(results, safeMeta, conversationResults, dtResults);
    frame.srcdoc = htmlReport;

    if (frame.style.display === 'none') {
      frame.style.display = 'block';
      emptyMsg.style.display = 'none';
    }

    const total = results.length + dtResults.length;
    const isNew = total > lastResultCount;
    lastResultCount = total;

    dot.className = 'dot' + (isNew ? '' : ' idle');
    const now = new Date().toLocaleTimeString();
    statusText.innerHTML =
      `<span class="dot${isNew ? '' : ' idle'}" id="dot"></span>` +
      `Updated ${now} &nbsp;·&nbsp; ${results.length} prompts &nbsp;·&nbsp; ${dtResults.length} DT paths`;
  });
}

refreshBtn.addEventListener('click', refresh);
refresh();
setInterval(refresh, 3000);
