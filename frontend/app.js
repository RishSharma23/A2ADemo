angular.module('a2aDemoApp', ['ngSanitize'])
.controller('ChatController', ['$scope', '$sce', function($scope, $sce) {
  // 1) Setup
  const assistantClient = new A2AClient("http://localhost:41231");
  $scope.messages       = [];
  $scope.streamingReply = "";
  $scope.artifact       = null;
  $scope.loading        = false;
  $scope.userInput      = "";

  // 2) Send + stream
  $scope.sendMessage = async function() {
    const text = $scope.userInput.trim();
    if (!text) return;

    // Push user
    $scope.messages.push({ sender: 'user', content: text });
    $scope.streamingReply = "";
    $scope.artifact       = null;
    $scope.loading        = true;
    $scope.userInput      = "";

    const params = {
      message: {
        messageId: uuidv4(),
        role: "user",
        kind: "message",
        parts: [{ kind: "text", text }]
      },
      configuration: {
        acceptedOutputModes: ["text/plain", "text/markdown", "application/json"]
      }
    };

    try {
      const stream = assistantClient.sendMessageStream(params);
      for await (const event of stream) {
        if (event.kind === "status-update") {
          const msg = event.status.message;
          if (msg?.parts?.length) {
            const chunk = msg.parts.map(p => p.text).join('');
            if (!event.final) {
              $scope.streamingReply += chunk;
            } else {
              const fullHtml = $sce.trustAsHtml(markdownToHtml($scope.streamingReply + chunk));
              $scope.messages.push({ sender: 'assistant', content: fullHtml });
              $scope.streamingReply = "";
            }
          }
        }
        else if (event.kind === "artifact-update") {
          const art = event.artifact;
          const raw = art.parts.map(p => p.text).join('');
          if (art.name?.endsWith('.json')) {
            let dataObj = null;
            try { dataObj = JSON.parse(raw); } catch {}
            $scope.artifact = { type:'json', raw, data:dataObj };
          }
          else if (art.parts[0].base64) {
            const blob = b64toBlob(art.parts[0].base64, art.mimeType||'application/octet-stream');
            $scope.artifact = { type:'binary', blob, name:art.name };
          }
          else {
            $scope.artifact = { type:'text', raw };
          }
        }

        $scope.$applyAsync();
        if (event.final) break;
      }
    } catch(err) {
      console.error("Streaming error:", err);
      $scope.messages.push({ sender:'assistant', content: `⚠️ Error: ${err.message}` });
    } finally {
      $scope.loading = false;
      $scope.$applyAsync();
    }
  };

  // 3) Markdown → HTML
  function markdownToHtml(md) {
    return md
      .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }
  $scope.trustMarkdown    = md => $sce.trustAsHtml(markdownToHtml(md));
  $scope.createObjectURL  = blob => URL.createObjectURL(blob);

  // 4) Base64 → Blob helper
  function b64toBlob(b64, mime) {
    const bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
    for (let i=0; i<len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
}]);
