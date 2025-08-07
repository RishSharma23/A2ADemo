angular.module('a2aDemoApp', ['ngSanitize'])
.controller('ChatController', ['$scope', '$sce', '$timeout', function($scope, $sce, $timeout) {
  // 1) Setup
  const assistantClient = new A2AClient("http://localhost:41231");
  $scope.messages       = [];
  $scope.streamingReply = "";
  $scope.artifact       = null;
  $scope.loading        = false;
  $scope.userInput      = "";

  // 2) Send message and stream response
  $scope.sendMessage = async function() {
    const text = $scope.userInput.trim();
    if (!text) return;
    // Append the user's message to the chat
    $scope.messages.push({ sender: 'user', content: text });
    // Reset temporary state
    $scope.streamingReply = "";
    $scope.artifact       = null;
    $scope.loading        = true;
    $scope.userInput      = "";

    // Define the message parameters including accepted output modes
    const params = {
      message: {
        messageId: uuidv4(),
        role: "user",
        kind: "message",
        parts: [{ kind: "text", text }]
      },
      configuration: {
        acceptedOutputModes: ["text/plain", "text/markdown", "text/html", "application/json", "image/png"]
      }
    };

    try {
      const stream = assistantClient.sendMessageStream(params);
      for await (const event of stream) {
        if (event.kind === "status-update") {
          // Agent is sending/streaming a message (partial or final)
          const msg = event.status.message;
          if (msg?.parts?.length) {
            const chunk = msg.parts.map(p => p.text).join('');
            if (!event.final) {
              // Append streaming text chunk
              $scope.streamingReply += chunk;
            } else {
              // Final message received – push the completed assistant message
              const fullHtml = $sce.trustAsHtml(markdownToHtml($scope.streamingReply + chunk));
              $scope.messages.push({ sender: 'assistant', content: fullHtml });
              $scope.streamingReply = "";
            }
          }
        }
        else if (event.kind === "artifact-update") {
          // Agent provided an artifact (file, image, or data)
          const art = event.artifact;
          // Reconstruct raw content for convenience
          const raw = art.parts[0].text ?? '';
          if (art.name?.endsWith('.json')) {
            // JSON artifact (could be data or chart)
            let dataObj = null;
            try { dataObj = JSON.parse(raw); } catch {}
            if (dataObj && dataObj.type === 'chartjs') {
              // Chart data artifact – prepare to render
              $scope.artifact = { type: 'chart', config: dataObj.chart };
              
            } else {
              // Generic JSON data artifact
              $scope.artifact = { type: 'json', raw, data: dataObj };
            }
          }
          else if (art.parts[0].base64) {
            // Binary artifact (e.g., file download or image)
            const blob = b64toBlob(art.parts[0].base64, art.mimeType || 'application/octet-stream');
            const url = URL.createObjectURL(blob);
            const trustedUrl = $sce.trustAsResourceUrl(url);
            // Mark it trusted so Angular won’t prefix with unsafe:
            $scope.artifact = { type: 'binary', url: trustedUrl, name: art.name };
          }
          else {
            // Plain text artifact (fallback)
            $scope.artifact = { type: 'text', raw };
          }
        }

        // Apply scope changes for this iteration
        $scope.$applyAsync();
        if (event.final) break;
      }
    } catch (err) {
      console.error("Streaming error:", err);
      $scope.messages.push({ sender: 'assistant', content: `⚠️ Error: ${err.message}` });
    } finally {
      $scope.loading = false;
      // If we just received a chart config, draw it now that the DOM is ready:
      if ($scope.artifact?.type === 'chart') {
        $timeout(() => {
           const canvas = document.getElementById('chartCanvas');
           if (canvas) {
            new Chart(canvas.getContext('2d'), $scope.artifact.config);
           }
          });

        }

      $scope.$applyAsync();
    }
  };

  // 3) Markdown-to-HTML conversion (for assistant messages)
  function markdownToHtml(md) {
    return md
      .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }
  $scope.trustMarkdown = md => $sce.trustAsHtml(markdownToHtml(md));

  // 4) Helper to create object URLs for binary data (for download links & images)
  $scope.createObjectURL = blob => URL.createObjectURL(blob);

  function b64toBlob(b64, mime) {
    const bin = atob(b64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = bin.charCodeAt(i);
    }
    return new Blob([arr], { type: mime });
  }
}]);
