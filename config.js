// Production config. Public-agent mode: the agent's origin allowlist + call caps protect it.
// To switch to signed URLs later: set signedUrlEndpoint to an https endpoint that returns {"signed_url": "wss://..."} (see README), then turn agent auth on.
window.CLARA_CONFIG = {
  "agentId": "agent_5601m5t7xsxde0jsk4c63m4trqbd",
  "connectionType": "websocket",
  "signedUrlEndpoint": null,
  "glb": "./clara_web_v2.2b03fca6bc.glb",
  "glbMobile": "./clara_web_mobile.faa45fe643.glb"
};
