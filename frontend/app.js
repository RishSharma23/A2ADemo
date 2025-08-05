
angular.module('A2ADemoApp', [])
.controller('ChatController', ['$scope', function($scope) {
  // Grab A2AClient from the global UMD
  const { A2AClient } = window;
  // Available agents
  $scope.agents = [
    { name: "Assistant Agent",  url: "http://localhost:3000" },
    { name: "Calculator Agent", url: "http://localhost:3001" },
    { name: "Weather Agent",    url: "http://localhost:3002" }
  ];
  $scope.selectedAgent = $scope.agents[0];
  $scope.userQuery   = "";
  $scope.chatLog     = [];
  $scope.artifacts   = [];

  $scope.sendMessage = function() {
    const baseUrl = $scope.selectedAgent.url;
    const text    = $scope.userQuery.trim();
    if (!text) return;

    // 1) Show the user’s message
    $scope.chatLog.push({ role: 'user',  text });

    // 2) Clear for new stream
    $scope.artifacts = [];
    $scope.userQuery = "";

    // 3) Create the streaming client
    const client = new A2AClient(baseUrl);
    const stream = client.sendMessageStream({
      message: {
        messageId: Date.now().toString(),
        kind:      "message",
        role:      "user",
        parts:    [{ kind: "text", text }]
      },
      configuration: {
        acceptedOutputModes: ["text/plain"]
      }
    });

    // 4) Consume the async stream
    (async () => {
      try {
        for await (const event of stream) {
          // Text updates
          if (event.kind === 'status-update' && event.status?.message?.parts) {
            const msg = event.status.message.parts[0].text;
            $scope.$apply(() => {
              $scope.chatLog.push({ role: 'agent', text: msg });
            });
            // Stop on final state
            if (event.status.state === 'completed' || event.status.state === 'failed') {
              break;
            }
          }
          // Artifact (file) updates
          else if (event.kind === 'artifact-update' && event.artifact?.parts) {
            const filename = event.artifact.name || "artifact.txt";
            const content  = event.artifact.parts[0].text;
            const blob     = new Blob([content], { type: 'text/plain' });
            const url      = URL.createObjectURL(blob);
            $scope.$apply(() => {
              $scope.artifacts.push({ filename, dataURL: url });
            });
          }
        }
      } catch (err) {
        console.error("Stream error:", err);
        $scope.$apply(() => {
          $scope.chatLog.push({ role: 'agent', text: '⚠️ Stream error: ' + err.message });
        });
      }
    })();
  };
}]);
