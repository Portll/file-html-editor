chrome.action.onClicked.addListener(tab => {
  if (!tab.url?.startsWith('file://')) return;
  chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: () => window.__fileHtmlEditor?.toggle() })
    .catch(() => {});
});
