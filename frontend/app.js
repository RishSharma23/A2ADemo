angular.module('A2ADemoApp', [])
.controller('ChatController', ['$scope', '$sce', function($scope, $sce) {
  const { A2AClient } = window;

  $scope.agents = [
    { name: "Assistant Agent",  url: "http://localhost:3000" },
    { name: "Calculator Agent", url: "http://localhost:3001" },
    { name: "Weather Agent",    url: "http://localhost:3002" }
  ];
  $scope.selectedAgent = $scope.agents[0];
  $scope.userQuery    = "";
  $scope.chatLog      = [];
  $scope.artifacts    = [];

  $scope.sendMessage = function() {
    const baseUrl = $scope.selectedAgent.url;
    const text    = $scope.userQuery.trim();
    if (!text) return;

    $scope.chatLog.push({ role: 'user', text });
    $scope.artifacts = [];
    $scope.userQuery = "";

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

    (async () => {
      try {
        for await (const event of stream) {
          if (event.kind === 'status-update' && event.status?.message?.parts) {
            const msg = event.status.message.parts[0].text;
            $scope.$apply(() => {
              $scope.chatLog.push({ role: 'agent', text: msg });
            });
            if (event.status.state === 'completed' || event.status.state === 'failed') {
              break;
            }
          }
          else if (event.kind === 'artifact-update' && event.artifact?.parts) {
            const filename = event.artifact.name || "artifact.txt";
            const content  = event.artifact.parts[0].text;
            const blob     = new Blob([content], { type: 'text/plain' });
            const url      = URL.createObjectURL(blob);
            // trust it
            const trustedUrl = $sce.trustAsResourceUrl(url);
            $scope.$apply(() => {
              $scope.artifacts.push({ filename, dataURL: trustedUrl });
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
