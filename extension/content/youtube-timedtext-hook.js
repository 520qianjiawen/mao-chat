/* Injected into YouTube's MAIN world so we see the player's own timedtext
 * requests. Those URLs carry the pot token; a content-script fetch without it
 * now comes back empty and the side panel silently falls back to ASR.
 */
(function () {
  if (window.__maoYtTimedtextHooked__) return;
  window.__maoYtTimedtextHooked__ = true;

  function publish(url, responseText) {
    try {
      window.postMessage({
        type: 'mao-youtube-timedtext',
        url: String(url || ''),
        response: String(responseText || ''),
      }, window.location.origin);
    } catch {
      // Ignore cross-origin or detached-window failures.
    }
  }

  function looksLikeTimedText(url) {
    return typeof url === 'string' && url.indexOf('timedtext') !== -1;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    const url = args[1];
    if (looksLikeTimedText(url)) {
      this.addEventListener('load', function () {
        publish(this.responseURL || url, this.responseText);
      });
    }
    return originalOpen.apply(this, args);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string'
      ? input
      : (input && typeof input.url === 'string' ? input.url : '');
    const request = originalFetch.apply(this, arguments);
    if (looksLikeTimedText(url)) {
      request.then((response) => {
        response.clone().text().then((text) => {
          publish(response.url || url, text);
        }).catch(() => {});
      }).catch(() => {});
    }
    return request;
  };
})();
