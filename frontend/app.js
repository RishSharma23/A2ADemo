angular.module('a2aDemoApp', ['ngSanitize'])
.controller('ChatController', ['$scope', '$sce', '$timeout', function($scope, $sce, $timeout) {
  const assistantClient = new A2AClient("http://localhost:41231");
  $scope.messages       = [];
  $scope.streamingReply = "";
  $scope.artifact       = null;
  $scope.loading        = false;
  $scope.userInput      = "";
  $scope.hitlPending    = null;   // { taskId, contextId }

  $scope.sendMessage = async function() {
    const text = $scope.userInput.trim();
    if (!text) return;

    $scope.messages.push({ sender: 'user', html: escapeHtml(text) });
    $scope.streamingReply = "";
    $scope.artifact       = null;
    $scope.loading        = true;

    const message = {
      messageId: uuidv4(),
      role: "user",
      kind: "message",
      parts: [{ kind: "text", text }]
    };

    // FIX: always continue with the ASSISTANT'S taskId/contextId (not the tool's)
    if ($scope.hitlPending) {
      message.taskId    = $scope.hitlPending.taskId;
      message.contextId = $scope.hitlPending.contextId;
    }

    const params = {
      message,
      configuration: {
        acceptedOutputModes: ["text/plain","text/markdown","text/html","application/json","image/png"],
        blocking: false
      }
    };
    $scope.userInput = "";

    try {
      const stream = assistantClient.sendMessageStream(params);

      // Separate buffers: do NOT carry “working” text into the final bubble
      let finalMsgHtml = "";
      let collectedCites = [];
      let lastIntentPath = null;
      let sawInputReq = false;

      for await (const event of stream) {
        if (event.kind === "status-update") {
          const st = event.status || {};
          const msg = st.message || {};
          const state = st.state;

          // FIX: Only mark HITL using assistant's IDs — ignore any msg.taskId from tools
          if (state === "input-required") {
            sawInputReq = true;
            $scope.hitlPending = { taskId: event.taskId, contextId: event.contextId }; // FIX
          }

          // Collect citations/intentPath
          if (Array.isArray(msg.citations)) collectedCites.push(...msg.citations);
          if (Array.isArray(msg.intentPath)) lastIntentPath = msg.intentPath;

          // FIX: ignore non-final text (avoid duplicating “working” lines)
          if (state === "completed" && msg?.parts?.length) {
            finalMsgHtml += msg.parts.map(p => p.text || "").join('');
          }
        }
        else if (event.kind === "artifact-update") {
          const art = event.artifact;
          const cites = art.citations || [];
          const raw = art.parts?.[0]?.text ?? '';

          if (art.name?.endsWith('.json')) {
            let dataObj = null; try { dataObj = JSON.parse(raw); } catch {}
            if (dataObj && dataObj.type === 'chartjs') {
              $scope.artifact = { type: 'chart', config: dataObj.chart, citations: cites };
            } else {
              $scope.artifact = { type: 'json', raw, data: dataObj, citations: cites };
            }
          } else if (art.parts?.[0]?.base64) {
            const blob = b64toBlob(art.parts[0].base64, art.mimeType || 'application/octet-stream');
            const url  = URL.createObjectURL(blob);
            const trustedUrl = $sce.trustAsResourceUrl(url);
            $scope.artifact = { type: 'binary', url: trustedUrl, name: art.name, citations: cites };
          } else {
            $scope.artifact = { type: 'text', raw, citations: cites };
          }
        }

        $scope.$applyAsync();
        if (event.final) break;
      }

      // Final assistant bubble (final text only)
      if (finalMsgHtml) {
        const html = markdownToHtml(finalMsgHtml);
        $scope.messages.push({
          sender: 'assistant',
          html: $sce.trustAsHtml(html),
          citations: collectedCites.length ? collectedCites : undefined,
          intentPath: lastIntentPath || undefined,
          hitl: sawInputReq || undefined
        });
      }

      // If no longer waiting for HITL, clear
      if (!sawInputReq) $scope.hitlPending = null;

    } catch (err) {
      console.error("Streaming error:", err);
      $scope.messages.push({ sender: 'assistant', html: $sce.trustAsHtml(`⚠️ Error: ${escapeHtml(err.message)}`) });
      $scope.hitlPending = null;
    } finally {
      $scope.loading = false;
      if ($scope.artifact?.type === 'chart') {
        $timeout(() => {
          const canvas = document.getElementById('chartCanvas');
          if (canvas) new Chart(canvas.getContext('2d'), $scope.artifact.config);
        });
      }
      $scope.$applyAsync();
    }
  };

  // === Helpers ===
  function markdownToHtml(md) {
    return md
      .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  $scope.trustMarkdown = md => $sce.trustAsHtml(markdownToHtml(md));
  $scope.hasCitations = msg => Array.isArray(msg.citations) && msg.citations.length > 0;
  $scope.intentPathString = msg => Array.isArray(msg.intentPath) ? msg.intentPath.join(' → ') : null;
  $scope.cancelHitl = () => { $scope.hitlPending = null; };

  function b64toBlob(b64, mime) {
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
}]);
