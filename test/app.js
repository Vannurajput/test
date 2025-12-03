/**
 * history/app.js
 * Controls the standalone history popup window UI.
 */
if (!window.browserBridge) {
  throw new Error('History bridge missing');
}

window.addEventListener('contextmenu', (event) => event.preventDefault());

const historyList = document.getElementById('historyList');
const closeButton = document.getElementById('historyClose');
const clearButton = document.getElementById('clearHistory');

const state = {
  entries: []
};

const render = () => {
  if (!historyList) {
    return;
  }
  historyList.innerHTML = '';

  if (!state.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No history yet';
    historyList.appendChild(empty);
    return;
  }

  state.entries.forEach((entry) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-entry';

    const title = document.createElement('div');
    title.className = 'history-entry-title';
    title.textContent = entry.title || entry.url;
    item.appendChild(title);

    const url = document.createElement('div');
    url.className = 'history-entry-url';
    url.textContent = entry.url;
    item.appendChild(url);

    item.addEventListener('click', () => {
      window.browserBridge.navigate(entry.url);
      window.browserBridge.closeHistoryPopup();
    });

    historyList.appendChild(item);
  });
};

closeButton?.addEventListener('click', () => window.browserBridge.closeHistoryPopup());

clearButton?.addEventListener('click', () => {
  window.browserBridge.clearHistory().then(() => {
    state.entries = [];
    render();
  });
});

window.browserBridge.getHistory().then((entries) => {
  state.entries = entries || [];
  render();
});

window.browserBridge.onHistoryUpdate((entries) => {
  state.entries = entries || [];
  render();
});
